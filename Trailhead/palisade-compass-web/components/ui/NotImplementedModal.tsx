"use client";

import { X } from "lucide-react";
import { createPortal } from "react-dom";

interface NotImplementedModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function NotImplementedModal({
  isOpen,
  onClose,
  title,
  children,
}: NotImplementedModalProps) {
  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-white/20 backdrop-blur-sm p-4 pt-16 sm:pt-[33vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.12),0_4px_16px_rgba(0,0,0,0.08)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-gray-200 p-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
            <p className="mt-1 text-sm font-medium text-amber-600">
              Not Implemented Yet
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4">
          <div className="text-sm text-gray-700 space-y-3">{children}</div>

          <div className="mt-6 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-600 text-white rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
