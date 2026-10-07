import * as ProcessRunner from "../processRunner.ts";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as WorkspaceSafety from "./WorkspaceSafety.ts";

it.effect(
  "refuses a protected root, symlink and an outside worktree sharing its Git common directory",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const safety = yield* WorkspaceSafety.WorkspaceSafety;
      const runner = yield* ProcessRunner.ProcessRunner;
      const git = (args: ReadonlyArray<string>) =>
        runner
          .run({ command: "git", args })
          .pipe(Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0))));
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-safety-" });
      const protectedRoot = path.join(base, "template");
      const worktree = path.join(base, "outside-worktree");
      const alias = path.join(base, "alias");
      yield* fs.makeDirectory(protectedRoot);
      yield* git(["init", "--quiet", protectedRoot]);
      yield* git([
        "-C",
        protectedRoot,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ]);
      yield* git([
        "-C",
        protectedRoot,
        "worktree",
        "add",
        "--quiet",
        "-b",
        "fixture-worktree",
        worktree,
      ]);
      yield* fs.symlink(protectedRoot, alias);
      const layerPolicy = ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { T3CODE_WORKSPACE_DENY_ROOTS: JSON.stringify([protectedRoot]) },
        }),
      );
      for (const root of [
        protectedRoot,
        alias,
        worktree,
        path.join(protectedRoot, "not-created"),
      ]) {
        const result = yield* Effect.exit(
          safety.assertAllowed(root).pipe(Effect.provide(layerPolicy)),
        );
        assert.equal(result._tag, "Failure", root);
      }
      yield* safety.assertAllowed(path.join(base, "unmanaged")).pipe(Effect.provide(layerPolicy));
      yield* safety
        .assertAllowed(protectedRoot)
        .pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(WorkspaceSafety.layer, ProcessRunner.layer).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("refuses filesystem case aliases when the filesystem supports them", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const safety = yield* WorkspaceSafety.WorkspaceSafety;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-case-policy-" });
    const root = path.join(base, "Templates");
    const alias = path.join(base, "templates");
    yield* fs.makeDirectory(root);
    if (!(yield* fs.exists(alias))) return;
    const result = yield* safety.assertAllowed(path.join(alias, "not-created")).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              T3CODE_WORKSPACE_DENY_ROOTS: JSON.stringify([root]),
            },
          }),
        ),
      ),
      Effect.result,
    );
    assert.equal(result._tag, "Failure");
  }).pipe(
    Effect.scoped,
    Effect.provide(WorkspaceSafety.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

it.effect("asks for a workspace when policy is enabled without a root", () =>
  Effect.gen(function* () {
    const safety = yield* WorkspaceSafety.WorkspaceSafety;
    const failure = yield* safety.assertAllowed(null).pipe(Effect.flip);
    assert.match(failure.message, /Choose a workspace root/);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        WorkspaceSafety.layer.pipe(Layer.provide(NodeServices.layer)),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              T3CODE_WORKSPACE_DENY_ROOTS: '["/tmp/protected"]',
            },
          }),
        ),
      ),
    ),
  ),
);
