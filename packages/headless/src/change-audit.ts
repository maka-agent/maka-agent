/**
 * Audit fields shared by RSI prompt candidates and AHE change manifests.
 *
 * The value types are generic because RSI stores compact signal/task ids in
 * its WAL, while AHE manifests carry source-backed evidence case objects.
 */
export interface MakaChangeAuditRecord<
  TEditedSurface extends string = string,
  TEvidenceRef = string,
  TPredictedFix = string,
  TRiskTask = string,
  TFallbackFailurePattern extends string = string,
> {
  editedSurface: TEditedSurface;
  evidenceRefs: readonly TEvidenceRef[];
  hypothesis: string;
  targetedFix: string;
  predictedFixes: readonly TPredictedFix[];
  riskTasks: readonly TRiskTask[];
  /** Coarse fallback for records that cannot cite a mined signature or signal. */
  failurePattern?: TFallbackFailurePattern;
}
