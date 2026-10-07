import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export class WorkspaceSafetyError extends Schema.TaggedError<WorkspaceSafetyError>()(
  "WorkspaceSafetyError",
  {
    workspaceRoot: Schema.NullOr(Schema.String),
    reason: Schema.Literals(["protected", "configuration", "inspection"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "protected":
        return "Workspace safety refused this workspace or its Git common directory. Choose a checkout outside T3CODE_WORKSPACE_DENY_ROOTS.";
      case "configuration":
        return "T3CODE_WORKSPACE_DENY_ROOTS must be a JSON array of absolute directory paths.";
      case "inspection":
        return "Workspace safety could not inspect the workspace or its Git metadata. Check filesystem permissions and repair the checkout before retrying.";
    }
  }
}

const deniedRootsSchema = Schema.Array(Schema.String.check(Schema.isNonEmpty())).check(
  Schema.isMaxLength(100),
);

export class WorkspaceSafety extends Context.Service<
  WorkspaceSafety,
  {
    readonly assertAllowed: (
      workspaceRoot: string | null,
    ) => Effect.Effect<void, WorkspaceSafetyError>;
  }
>()("t3/workspace/WorkspaceSafety") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const assertAllowed = Effect.fn("WorkspaceSafety.assertAllowed")(function* (
    workspaceRoot: string | null,
  ) {
    const configured = yield* Config.String("T3CODE_WORKSPACE_DENY_ROOTS").pipe(
      Config.withDefault("[]"),
      Effect.mapError(
        (cause) => new WorkspaceSafetyError({ workspaceRoot, reason: "configuration", cause }),
      ),
    );
    const deniedRoots = yield* Schema.decodeEffect(Schema.fromJsonString(deniedRootsSchema))(
      configured,
    ).pipe(
      Effect.mapError(
        (cause) => new WorkspaceSafetyError({ workspaceRoot, reason: "configuration", cause }),
      ),
      Effect.filterOrFail(
        (roots) => roots.every((root) => path.isAbsolute(root)),
        () => new WorkspaceSafetyError({ workspaceRoot, reason: "configuration" }),
      ),
    );
    if (deniedRoots.length === 0) return;
    if (workspaceRoot === null)
      return yield* new WorkspaceSafetyError({ workspaceRoot, reason: "inspection" });
    const canonicalPath = (
      candidate: string,
    ): Effect.Effect<string, import("effect/PlatformError").PlatformError> =>
      fs.realPath(candidate).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" && path.dirname(candidate) !== candidate
              ? canonicalPath(path.dirname(candidate)).pipe(
                  Effect.map((parent) => path.join(parent, path.basename(candidate))),
                )
              : Effect.fail(error),
        }),
      );
    const inspect = Effect.gen(function* () {
      const roots = yield* Effect.forEach(deniedRoots, (root) => canonicalPath(path.resolve(root)));
      const assertOutside = (candidate: string) => {
        const protectedPath = roots.some((root) => {
          const relative = path.relative(root, candidate);
          return (
            relative === "" ||
            (!path.isAbsolute(relative) &&
              relative !== ".." &&
              !relative.startsWith(`..${path.sep}`))
          );
        });
        return protectedPath
          ? Effect.fail(new WorkspaceSafetyError({ workspaceRoot, reason: "protected" }))
          : Effect.void;
      };
      const root = yield* canonicalPath(path.resolve(workspaceRoot));
      yield* assertOutside(root);
      let directory = root;
      while (true) {
        const marker = path.join(directory, ".git");
        const stat = yield* fs.stat(marker).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
          }),
        );
        if (stat !== null) {
          let gitDirectory: string;
          if (stat.type === "Directory") gitDirectory = yield* fs.realPath(marker);
          else {
            const contents = yield* fs.readFileString(marker);
            const gitdir = /^gitdir: (.+)\s*$/u.exec(contents)?.[1]?.trim();
            if (!gitdir)
              return yield* new WorkspaceSafetyError({ workspaceRoot, reason: "inspection" });
            gitDirectory = yield* fs.realPath(path.resolve(directory, gitdir));
          }
          yield* assertOutside(gitDirectory);
          const common = yield* fs.readFileString(path.join(gitDirectory, "commondir")).pipe(
            Effect.catchTags({
              PlatformError: (error) =>
                error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
            }),
          );
          if (common !== null)
            yield* assertOutside(yield* fs.realPath(path.resolve(gitDirectory, common.trim())));
          return;
        }
        const parent = path.dirname(directory);
        if (parent === directory) return;
        directory = parent;
      }
    });
    yield* inspect.pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(new WorkspaceSafetyError({ workspaceRoot, reason: "inspection", cause })),
      }),
    );
  });

  return WorkspaceSafety.of({ assertAllowed });
});

export const layer = Layer.effect(WorkspaceSafety, make);
