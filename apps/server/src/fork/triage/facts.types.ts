import type {
  ThreadPullRequestKey,
  TriageCiState,
  TriageMergeable,
  TriageReviewState,
} from "@t3tools/contracts";

export interface TriageReviewer {
  readonly login: string;
  readonly isBot: boolean;
}

export interface TriageThreadFacts {
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path: string | null;
  readonly author: string;
  readonly authorIsBot: boolean;
  readonly lastAuthor: string;
  readonly lastAuthorIsBot: boolean;
  readonly lastAt: string;
  readonly awaitingAuthor: boolean;
}

export interface TriageCommentFacts {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface TriageCiFacts {
  readonly state: TriageCiState;
  readonly failing: ReadonlyArray<string>;
  readonly cancelled: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<string>;
  readonly awaitingAuthorization: number;
  readonly passed: number;
}

export interface TriageTrunkFacts {
  readonly managed: boolean;
  readonly failed: boolean;
  readonly message: string | null;
}

export interface TriageFacts {
  readonly key: ThreadPullRequestKey;
  readonly url: string;
  readonly title: string;
  readonly isDraft: boolean;
  readonly headSha: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastPushAt: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly review: TriageReviewState;
  readonly approvers: ReadonlyArray<TriageReviewer>;
  readonly changeRequesters: ReadonlyArray<TriageReviewer>;
  readonly requestedReviewers: ReadonlyArray<string>;
  readonly mergeable: TriageMergeable;
  readonly ci: TriageCiFacts;
  readonly trunk: TriageTrunkFacts;
  readonly threads: ReadonlyArray<TriageThreadFacts>;
  readonly threadsTruncated: boolean;
  readonly humanComments: ReadonlyArray<TriageCommentFacts>;
}
