"use client";

import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  maxWidth?: "sm" | "md" | "lg" | "xl" | "2xl";
  fullScreenMobile?: boolean;
}

const maxWidthClasses = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-xl",
  xl: "max-w-2xl",
  "2xl": "max-w-4xl",
};

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  maxWidth = "lg",
  fullScreenMobile = false,
}: ModalProps) {
  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-white/20 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={cn(
          "absolute bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.12),0_4px_16px_rgba(0,0,0,0.08)] overflow-hidden",
          fullScreenMobile
            ? "inset-x-0 top-[10vh] bottom-0 rounded-t-2xl sm:rounded-lg sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:h-[70vh] sm:w-[900px]"
            : `left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-auto h-[90vh] rounded-lg sm:h-[70vh] ${maxWidthClasses[maxWidth]}`
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-full flex flex-col">
          {/* Header */}
          <div className="flex items-start justify-between border-b border-gray-200 p-4 flex-shrink-0">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
              {description && (
                <p className="mt-1 text-sm text-gray-500">{description}</p>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Content - scrollable */}
          <div className="overflow-y-auto flex-1 min-h-0">{children}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}
