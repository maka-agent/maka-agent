export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  question: string;
  options: UserQuestionOption[];
}

export interface UserQuestionRequest {
  requestId: string;
  toolUseId: string;
  questions: UserQuestion[];
}

export interface UserQuestionResponse {
  requestId: string;
  /** One answer per question, in request order. `null` means unanswered. */
  answers: Array<string | null>;
}

export interface UserQuestionResult {
  answers: Array<{ question: string; answer: string | null }>;
}
