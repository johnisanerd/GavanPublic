"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface InitiativeFormProps {
  legislatorId: string;
  sessionId: string;
  onCreated: () => void;
  onCancel: () => void;
}

const POLICY_AREAS = [
  "AI & Technology",
  "Healthcare",
  "Infrastructure",
  "Education",
  "Defense & Security",
  "Economy & Finance",
  "Environment & Energy",
  "Immigration",
  "Criminal Justice",
  "Agriculture",
  "Foreign Policy",
  "Other",
];

export function InitiativeForm({ legislatorId, sessionId, onCreated, onCancel }: InitiativeFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [policyArea, setPolicyArea] = useState("");
  const [goals, setGoals] = useState<string[]>([""]);
  const [submitting, setSubmitting] = useState(false);

  const addGoal = () => setGoals([...goals, ""]);
  const updateGoal = (index: number, value: string) => {
    const next = [...goals];
    next[index] = value;
    setGoals(next);
  };
  const removeGoal = (index: number) => {
    if (goals.length <= 1) return;
    setGoals(goals.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/initiatives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          legislatorId,
          title,
          description,
          policyArea,
          goals: goals.filter(Boolean),
        }),
      });
      if (res.ok) onCreated();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card padding="lg">
      <form onSubmit={handleSubmit} className="space-y-6">
        <h3 className="headline-md gold-thread pb-4">New Initiative</h3>

        <div>
          <label className="label-md block mb-2">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., Bipartisan AI Safety Framework"
            className="w-full px-5 py-3 text-base bg-surface-bright ghost-border focus:ring-2 focus:ring-gold/30 focus:outline-none"
            required
          />
        </div>

        <div>
          <label className="label-md block mb-2">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the initiative and its objectives..."
            rows={4}
            className="w-full px-5 py-3 text-base bg-surface-bright ghost-border focus:ring-2 focus:ring-gold/30 focus:outline-none resize-none"
            required
          />
        </div>

        <div>
          <label className="label-md block mb-2">Policy Area</label>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {POLICY_AREAS.map((area) => (
              <button
                key={area}
                type="button"
                onClick={() => setPolicyArea(area)}
                className={`py-3 px-4 text-sm font-semibold transition-tonal ${
                  policyArea === area
                    ? "bg-navy text-white"
                    : "bg-surface-low text-ink-light hover:bg-surface-mid"
                }`}
              >
                {area}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label-md block mb-2">Goals</label>
          <div className="space-y-2">
            {goals.map((goal, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={goal}
                  onChange={(e) => updateGoal(i, e.target.value)}
                  placeholder={`Goal ${i + 1}`}
                  className="flex-1 px-5 py-3 text-base bg-surface-bright ghost-border focus:ring-2 focus:ring-gold/30 focus:outline-none"
                />
                {goals.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeGoal(i)}
                    className="px-3 text-ink-muted hover:text-crimson transition-tonal"
                  >
                    &times;
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={addGoal}
              className="text-sm text-gold font-semibold hover:text-gold-dim transition-tonal"
            >
              + Add Goal
            </button>
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <Button type="submit" size="lg" disabled={submitting || !title || !description || !policyArea}>
            {submitting ? "Creating..." : "Create Initiative"}
          </Button>
          <Button type="button" variant="secondary" size="lg" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
