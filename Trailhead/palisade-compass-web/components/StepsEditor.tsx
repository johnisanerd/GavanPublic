"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useExperiment } from "@/lib/context/ExperimentContext";
import StepCard from "./StepCard";

function SortableStepCard({ index, id }: { index: number; id: string }) {
  const { form } = useExperiment();
  const steps = form.watch("steps");

  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({
      id,
      animateLayoutChanges: () => false,
    });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleDuplicate = (idx: number) => {
    const currentSteps = form.getValues("steps");
    const newSteps = [
      ...currentSteps.slice(0, idx + 1),
      { ...currentSteps[idx] },
      ...currentSteps.slice(idx + 1),
    ];
    form.setValue("steps", newSteps as [{ prompt: string }, ...{ prompt: string }[]]);
  };

  const handleDelete = (idx: number) => {
    const currentSteps = form.getValues("steps");
    if (currentSteps.length === 1) return;
    const newSteps = currentSteps.filter((_, i) => i !== idx);
    form.setValue("steps", newSteps as [{ prompt: string }, ...{ prompt: string }[]]);
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <StepCard
        index={index}
        form={form}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
        totalSteps={steps.length}
        dragHandleProps={listeners}
      />
    </div>
  );
}

export default function StepsEditor() {
  const { form } = useExperiment();
  const steps = form.watch("steps");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = steps.findIndex((_, i) => `step-${i}` === active.id);
      const newIndex = steps.findIndex((_, i) => `step-${i}` === over.id);

      const newSteps = arrayMove(steps, oldIndex, newIndex);
      form.setValue("steps", newSteps as [{ prompt: string }, ...{ prompt: string }[]]);
    }
  };

  const handleAddStep = () => {
    const currentSteps = form.getValues("steps");
    form.setValue("steps", [
      ...currentSteps,
      { prompt: "" },
    ] as [{ prompt: string }, ...{ prompt: string }[]]);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Alt+ArrowUp/ArrowDown for moving steps
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLTextAreaElement) {
          const match = activeElement.id.match(/step-(\d+)-prompt/);
          if (match) {
            const index = parseInt(match[1], 10);
            e.preventDefault();

            if (e.key === "ArrowUp" && index > 0) {
              const currentSteps = form.getValues("steps");
              const newSteps = arrayMove(currentSteps, index, index - 1);
              form.setValue("steps", newSteps as [{ prompt: string }, ...{ prompt: string }[]]);
            } else if (e.key === "ArrowDown" && index < steps.length - 1) {
              const currentSteps = form.getValues("steps");
              const newSteps = arrayMove(currentSteps, index, index + 1);
              form.setValue("steps", newSteps as [{ prompt: string }, ...{ prompt: string }[]]);
            }
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [form, steps.length]);

  return (
    <div>
      {mounted ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={steps.map((_, i) => `step-${i}`)}
            strategy={verticalListSortingStrategy}
          >
            <div className="relative">
              {/* Connecting line */}
              {steps.length > 1 && (
                <div className="absolute left-6 top-8 bottom-8 w-px border-l-2 border-dashed border-gray-300" />
              )}
              <div className="relative space-y-3">
                {steps.map((_, index) => (
                  <SortableStepCard
                    key={`step-${index}`}
                    id={`step-${index}`}
                    index={index}
                  />
                ))}
              </div>
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="relative">
          {/* Connecting line */}
          {steps.length > 1 && (
            <div className="absolute left-6 top-8 bottom-8 w-px border-l-2 border-dashed border-gray-300" />
          )}
          <div className="relative space-y-3">
            {steps.map((_, index) => (
              <div key={`step-${index}`}>
                <StepCard
                  index={index}
                  form={form}
                  onDuplicate={() => {}}
                  onDelete={() => {}}
                  totalSteps={steps.length}
                  dragHandleProps={{}}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={handleAddStep}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          <Plus className="h-4 w-4" />
          Add Step
        </button>
      </div>
    </div>
  );
}
