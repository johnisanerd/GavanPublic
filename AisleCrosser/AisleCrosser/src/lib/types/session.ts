export interface Session {
  id: string;
  legislatorId: string;
  createdAt: string;
  lastActiveAt: string;
  initiativeIds: string[];
  researchIds: string[];
}
