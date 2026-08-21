"use client";

import * as React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

const Accordion = AccordionPrimitive.Root;

const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item
    ref={ref}
    className={cn("border-b border-gray-200", className)}
    {...props}
  />
));
AccordionItem.displayName = "AccordionItem";

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => {
  const [isOpen, setIsOpen] = React.useState(false);

  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        ref={ref}
        className={cn(
          "flex flex-1 items-center justify-between py-4 font-medium transition-all hover:underline text-left",
          className
        )}
        onPointerDown={(e) => {
          setIsOpen((e.currentTarget as HTMLElement).getAttribute('data-state') !== 'open');
        }}
        {...props}
      >
        {children}
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          <ChevronDown className="h-4 w-4 shrink-0" />
        </motion.div>
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
});
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const checkState = () => {
      if (contentRef.current) {
        const state = contentRef.current.getAttribute('data-state');
        setIsOpen(state === 'open');
      }
    };

    const observer = new MutationObserver(checkState);

    if (contentRef.current) {
      checkState(); // Initial check
      observer.observe(contentRef.current, { attributes: true, attributeFilter: ['data-state'] });
    }

    return () => observer.disconnect();
  }, []);

  return (
    <AccordionPrimitive.Content
      ref={(node) => {
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
        contentRef.current = node;
      }}
      className="overflow-hidden text-sm"
      forceMount
      {...props}
    >
      <motion.div
        initial={false}
        animate={{
          height: isOpen ? "auto" : 0,
          opacity: isOpen ? 1 : 0,
        }}
        transition={{
          duration: 0.25,
          ease: [0.4, 0, 0.2, 1],
        }}
      >
        <div className={cn("pb-4 pt-0", className)}>{children}</div>
      </motion.div>
    </AccordionPrimitive.Content>
  );
});

AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
