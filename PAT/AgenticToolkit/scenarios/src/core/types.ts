/**
 * Scenario primitives — generic envelope around the per-kind content
 * packets (presentation, interview, demo, etc.).
 *
 * A Scenario is:
 *   - a content packet (per-kind shape — see `presentation/`, etc.)
 *   - a provisioned NanoClaw agent group + messaging-group wired to
 *     a channel suitable for the scenario
 *   - an entry in the scenarios index that operator UIs list +
 *     launch from
 *
 * Adding a new kind: add a sibling directory (e.g. `interview/`),
 * declare it in the `ScenarioKind` union below, and implement the
 * per-kind validator + provisioning content-writer adapter on the
 * NanoClaw side.
 */

export type ScenarioKind = 'presentation';

/** Row in the scenarios index. One per provisioned scenario.
 *  Kind-agnostic envelope. Kind-specific content lives in the packet
 *  on disk (under packet_dir); kind-specific display metadata that
 *  the operator UI wants in a list view goes under `display`. */
export interface ScenarioRow {
  slug: string;
  kind: ScenarioKind;
  title: string;
  audience?: string;
  /** NanoClaw agent_groups.id provisioned for this scenario. */
  agent_group_id?: string;
  /** NanoClaw messaging_groups.id wired for the runtime channel. */
  messaging_group_id?: string;
  /** Operator-visible launch URL on the runtime app (pat-web etc.). */
  launch_url?: string;
  created_at: string;
  /** Local filesystem path where the operator console kept a read-
   *  through copy of the packet. The authoritative copy is in
   *  NanoClaw's groups/<folder>/packet/. */
  packet_dir?: string;
  /** Kind-specific denormalized fields for fast list-view display
   *  (e.g. presentation packs slide_count + duration_budget_s here).
   *  Treat as opaque from the envelope's POV; cast per kind in the
   *  operator UI. */
  display?: Record<string, unknown>;
}

export interface ScenariosIndex {
  scenarios: ScenarioRow[];
}

/** Shape POSTed to NanoClaw's /scenarios/provision endpoint. */
export interface ProvisionRequest<Content = unknown> {
  kind: ScenarioKind;
  slug: string;
  content: Content;
}

export interface ProvisionResponse {
  agent_group_id: string;
  messaging_group_id: string;
  folder: string;
  packet_dir: string;
}
