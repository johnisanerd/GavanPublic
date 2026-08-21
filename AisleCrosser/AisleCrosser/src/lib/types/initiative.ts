export interface Initiative {
  id: string;
  sessionId: string;
  legislatorId: string;
  title: string;
  description: string;
  policyArea: string;
  goals: string[];
  existingBillIds?: string[];
  status: "draft" | "active" | "researching" | "completed";
  createdAt: string;
  updatedAt: string;
}

export interface CreateInitiativeInput {
  sessionId: string;
  legislatorId: string;
  title: string;
  description: string;
  policyArea: string;
  goals: string[];
  existingBillIds?: string[];
}
