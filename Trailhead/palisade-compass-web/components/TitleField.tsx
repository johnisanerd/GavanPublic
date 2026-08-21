"use client";

import { useState, useRef, useEffect } from "react";
import { Pencil, Check, X } from "lucide-react";
import { useExperiment } from "@/lib/context/ExperimentContext";

export default function TitleField() {
  const { form } = useExperiment();
  const { watch, setValue, formState: { errors } } = form;
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const currentTitle = watch("title");

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleEdit = () => {
    setEditValue(currentTitle);
    setIsEditing(true);
  };

  const handleSave = () => {
    if (editValue.trim()) {
      setValue("title", editValue.trim(), { shouldValidate: true });
      setIsEditing(false);
    }
  };

  const handleCancel = () => {
    setEditValue(currentTitle);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSave();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  return (
    <div className="mb-4">
      {isEditing ? (
        <div className="flex items-center justify-center gap-2 max-w-full">
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold text-gray-900 bg-transparent border-b-2 border-blue-500 focus:outline-none text-center"
            placeholder="Enter experiment title"
          />
          <button
            type="button"
            onClick={handleSave}
            className="flex-shrink-0 rounded-lg p-2 text-green-600 hover:bg-green-50 transition-colors"
          >
            <Check className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={handleCancel}
            className="flex-shrink-0 rounded-lg p-2 text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <div className="group flex items-center justify-center gap-3 max-w-full">
          <h1
            className="text-2xl sm:text-3xl font-bold text-gray-900 select-none cursor-pointer hover:text-gray-700 transition-colors break-words min-w-0 text-center"
            onClick={handleEdit}
          >
            {currentTitle || "Untitled Experiment"}
          </h1>
          <button
            type="button"
            onClick={handleEdit}
            className="flex-shrink-0 rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-all"
          >
            <Pencil className="h-5 w-5" />
          </button>
        </div>
      )}
      {errors.title && (
        <p className="mt-2 text-sm text-red-600 select-none text-center">{errors.title.message}</p>
      )}
    </div>
  );
}
