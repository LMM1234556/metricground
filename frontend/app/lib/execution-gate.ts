export type ExecutionGate = {
  ready: boolean;
  message: string;
  onReview?: () => void;
};
