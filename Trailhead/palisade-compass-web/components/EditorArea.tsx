"use client";

import { useState } from "react";
import TitleField from "./TitleField";
import StepsEditor from "./StepsEditor";
import ToolsEditor from "./ToolsEditor";
import SettingsSection from "./SettingsSection";
import { Tab } from "./ui/pricing-tab";

type TabId = "steps" | "tools" | "settings";

export default function EditorArea() {
  const [activeTab, setActiveTab] = useState<TabId>("steps");

  const tabs: { id: TabId; label: string }[] = [
    { id: "steps", label: "Steps" },
    { id: "tools", label: "Tools" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <div className="flex-1 overflow-y-auto bg-white flex flex-col">
      <div className="mx-auto max-w-5xl w-full flex flex-col flex-1">
        <div className="px-4 sm:px-6 pt-2 sm:pt-6 sm:pb-4">
          <TitleField />
        </div>

        {/* Tabs */}
        <div className="-mt-1 sm:mt-0 sm:pb-4 flex justify-center">
          <div className="flex w-fit rounded-full bg-muted p-1">
            {tabs.map((tab) => (
              <Tab
                key={tab.id}
                text={tab.label}
                selected={activeTab === tab.id}
                setSelected={() => setActiveTab(tab.id)}
              />
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {activeTab === "steps" && <StepsEditor />}
          {activeTab === "tools" && <ToolsEditor />}
          {activeTab === "settings" && <SettingsSection />}
        </div>
      </div>
    </div>
  );
}
