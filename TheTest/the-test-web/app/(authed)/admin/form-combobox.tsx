"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { listForms } from "./actions";

// Shared query so the create dialog, the change-form modal, and the experiment
// header (which resolves a bound form's title) all hit one cached fetch.
export function useForms() {
  return useQuery({
    queryKey: ["typeform-forms"],
    queryFn: () => listForms(),
    // Names are read live from Typeform; keep them reasonably fresh + re-pull
    // when you tab back from the Typeform builder after a rename.
    staleTime: 20_000,
    refetchOnWindowFocus: true,
  });
}

// Searchable Typeform-form picker (shadcn combobox: Popover + Command).
export function FormCombobox({
  value,
  onChange,
  placeholder = "Select a survey form…",
}: {
  value: string | null;
  onChange: (formId: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const { data: forms, isLoading, isError } = useForms();
  const selected = forms?.find((f) => f.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? selected.title : placeholder}
          </span>
          {isLoading ? (
            <Loader2 className="size-4 shrink-0 animate-spin opacity-50" />
          ) : (
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-[260px] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder="Search forms…" />
          <CommandList>
            {isError ? (
              <div className="text-destructive p-4 text-sm">
                Couldn’t load forms from Typeform.
              </div>
            ) : (
              <>
                <CommandEmpty>No forms found.</CommandEmpty>
                <CommandGroup>
                  {forms?.map((f) => (
                    <CommandItem
                      key={f.id}
                      // Searchable on both title and id; value is what cmdk filters.
                      value={`${f.title} ${f.id}`}
                      onSelect={() => {
                        onChange(f.id);
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          "size-4",
                          value === f.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="truncate">{f.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
