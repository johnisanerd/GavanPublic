import React, { useRef, useState, useEffect } from "react";
import { motion } from "framer-motion";

interface SlideTabsProps {
  tabs: string[];
  selected: number;
  onTabChange: (index: number) => void;
}

export const SlideTabs = ({ tabs, selected, onTabChange }: SlideTabsProps) => {
  const [position, setPosition] = useState({
    left: 0,
    width: 0,
    opacity: 0,
  });
  const tabsRef = useRef<(HTMLLIElement | null)[]>([]);

  // This effect runs when the component mounts or when the selected tab changes.
  // It calculates the position of the selected tab and sets the cursor.
  useEffect(() => {
    const selectedTab = tabsRef.current[selected];
    if (selectedTab) {
      const { width } = selectedTab.getBoundingClientRect();
      setPosition({
        left: selectedTab.offsetLeft,
        width,
        opacity: 1,
      });
    }
  }, [selected]);

  return (
    <ul
      onMouseLeave={() => {
        // When the mouse leaves the container, reset the cursor
        // to the position of the currently selected tab.
        const selectedTab = tabsRef.current[selected];
        if (selectedTab) {
          const { width } = selectedTab.getBoundingClientRect();
          setPosition({
            left: selectedTab.offsetLeft,
            width,
            opacity: 1,
          });
        }
      }}
      className="relative mx-auto flex w-fit rounded-full border-2 border-black bg-white p-1 dark:border-white dark:bg-neutral-800"
    >
      {tabs.map((tab, i) => (
        <Tab
          key={tab}
          ref={(el) => {
            tabsRef.current[i] = el;
          }}
          setPosition={setPosition}
          onClick={() => onTabChange(i)}
        >
          {tab}
        </Tab>
      ))}

      <Cursor position={position} />
    </ul>
  );
};

interface TabProps {
  children: React.ReactNode;
  setPosition: (position: { left: number; width: number; opacity: number }) => void;
  onClick: () => void;
}

// The Tab component is wrapped in forwardRef to accept a ref from its parent.
const Tab = React.forwardRef<HTMLLIElement, TabProps>(
  ({ children, setPosition, onClick }, ref) => {
    return (
      <li
        ref={ref}
        onClick={onClick}
        onMouseEnter={() => {
          if (!ref || typeof ref === "function") return;
          const element = ref.current;
          if (!element) return;

          const { width } = element.getBoundingClientRect();

          setPosition({
            left: element.offsetLeft,
            width,
            opacity: 1,
          });
        }}
        className="relative z-10 block cursor-pointer px-3 py-1.5 text-xs uppercase text-white mix-blend-difference md:px-5 md:py-3 md:text-base"
      >
        {children}
      </li>
    );
  }
);

Tab.displayName = "Tab";

interface CursorProps {
  position: { left: number; width: number; opacity: number };
}

const Cursor = ({ position }: CursorProps) => {
  return (
    <motion.li
      animate={{
        ...position,
      }}
      className="absolute z-0 h-7 rounded-full bg-black dark:bg-white md:h-12"
    />
  );
};
