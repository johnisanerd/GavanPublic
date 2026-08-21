"use client";

import { useState, useCallback } from "react";
import type { PersonalConnection } from "@/lib/types/agent";

function connectionIcon(type: string, iconSuggestion?: string): string {
  if (iconSuggestion) return iconSuggestion;

  const t = type.toLowerCase();
  if (t.includes("sport") || t.includes("golf") || t.includes("fitness") || t.includes("running") || t.includes("basketball") || t.includes("baseball")) return "🏌️";
  if (t.includes("pet") || t.includes("animal") || t.includes("dog") || t.includes("cat")) return "🐾";
  if (t.includes("alma") || t.includes("university") || t.includes("law") || t.includes("professor") || t.includes("degree") || t.includes("school") || t.includes("college")) return "🎓";
  if (t.includes("family") || t.includes("grandchild") || t.includes("grandmother") || t.includes("mother") || t.includes("parent") || t.includes("child") || t.includes("daughter") || t.includes("son")) return "👨‍👩‍👧";
  if (t.includes("military") || t.includes("veteran") || t.includes("reserve") || t.includes("navy") || t.includes("army") || t.includes("marine") || t.includes("air force")) return "🎖️";
  if (t.includes("faith") || t.includes("church") || t.includes("methodist") || t.includes("baptist") || t.includes("catholic") || t.includes("christian") || t.includes("jewish") || t.includes("muslim")) return "🙏";
  if (t.includes("food") || t.includes("cook") || t.includes("cuisine") || t.includes("restaurant") || t.includes("barbeque") || t.includes("bbq")) return "🍽️";
  if (t.includes("travel")) return "✈️";
  if (t.includes("music") || t.includes("guitar") || t.includes("piano") || t.includes("bluegrass") || t.includes("country")) return "🎵";
  if (t.includes("book") || t.includes("author") || t.includes("reader") || t.includes("publish")) return "📚";
  if (t.includes("farm") || t.includes("rural") || t.includes("ranch") || t.includes("agriculture")) return "🌾";
  if (t.includes("cancer") || t.includes("survivor") || t.includes("health")) return "🎗️";
  if (t.includes("fish")) return "🎣";
  if (t.includes("hunt")) return "🦌";
  if (t.includes("art") || t.includes("paint")) return "🎨";
  if (t.includes("business") || t.includes("entrepreneur")) return "💼";
  if (t.includes("teach") || t.includes("education")) return "📖";
  return "🤝";
}

function formatConnectionType(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface ConnectionBadgeProps {
  connection: PersonalConnection;
  index: number;
  onDeepDive?: (connectionIndex: number) => void;
  isStreaming?: boolean;
}

export function ConnectionBadge({ connection, index, onDeepDive, isStreaming }: ConnectionBadgeProps) {
  const [isHovered, setIsHovered] = useState(false);
  const icon = connectionIcon(connection.type, connection.iconSuggestion);

  const handleClick = useCallback(() => {
    onDeepDive?.(index);
  }, [onDeepDive, index]);

  return (
    <button
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`
        group inline-flex items-start gap-2 text-left p-2.5 transition-all duration-200
        ${isStreaming ? "bg-gold/8 animate-pulse" : "bg-gold/5 hover:bg-gold/12"}
        ${onDeepDive ? "cursor-pointer" : "cursor-default"}
      `}
      title={`${connection.detail} — shared: ${connection.sharedWith}${connection.source ? `\nSource: ${connection.source}` : ""}`}
      disabled={!onDeepDive}
    >
      <span className="text-base flex-shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <span className="text-[10px] font-semibold text-gold-dim uppercase tracking-wider block">
          {formatConnectionType(connection.type)}
        </span>
        <p className="text-[12px] text-ink leading-snug mt-0.5">
          {connection.detail}
        </p>
        {connection.sharedWith && (
          <p className="text-[11px] text-ink-light mt-0.5">
            {connection.sharedWith}
          </p>
        )}
        {connection.source && (
          <p className="text-[10px] text-ink-muted mt-1 truncate">
            {connection.source}
          </p>
        )}
      </div>
      {onDeepDive && (
        <span className={`text-[10px] text-gold-dim flex-shrink-0 mt-0.5 transition-opacity ${isHovered ? "opacity-100" : "opacity-0"}`}>
          Deep dive →
        </span>
      )}
    </button>
  );
}
