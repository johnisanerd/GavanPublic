import { z } from "zod/v4";

export const createSessionSchema = z.object({
  legislatorId: z.string().min(1),
});

export const createInitiativeSchema = z.object({
  sessionId: z.string().min(1),
  legislatorId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  policyArea: z.string().min(1).max(100),
  goals: z.array(z.string().min(1)).min(1).max(10),
  existingBillIds: z.array(z.string()).optional(),
});

export const updateInitiativeSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(5000).optional(),
  policyArea: z.string().min(1).max(100).optional(),
  goals: z.array(z.string().min(1)).min(1).max(10).optional(),
  existingBillIds: z.array(z.string()).optional(),
  status: z.enum(["draft", "active", "researching", "completed"]).optional(),
});

export const launchResearchSchema = z.union([
  // Option 1: reference an existing initiative
  z.object({ initiativeId: z.string().min(1) }),
  // Option 2: create initiative inline (for Vercel where cross-function memory doesn't work)
  z.object({
    legislatorId: z.string().min(1),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(5000).optional(),
    policyArea: z.string().min(1).max(100).optional(),
    goals: z.array(z.string()).optional(),
    existingBillIds: z.array(z.string()).optional(),
  }),
]);

export const feedbackSchema = z.object({
  researchId: z.string().min(1),
  targetType: z.enum(["recommendation", "reasoning_step"]),
  targetId: z.string().min(1),
  value: z.enum(["up", "down"]).nullable(),
  comment: z.string().max(1000).optional(),
});

export const legislatorSearchSchema = z.object({
  q: z.string().optional(),
  chamber: z.enum(["senate", "house"]).optional(),
  party: z.enum(["D", "R", "I"]).optional(),
  state: z.string().length(2).optional(),
});

export const launchDeepDiveSchema = z.object({
  researchId: z.string().min(1),
  recommendationId: z.string().min(1),
  connectionIndex: z.number().int().min(0),
});
