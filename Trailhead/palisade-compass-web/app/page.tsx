import Header from "@/components/Header";
import EditorArea from "@/components/EditorArea";
import RunBar from "@/components/RunBar";
import { ExperimentProvider } from "@/lib/context/ExperimentContext";
import { ExecutionProvider } from "@/lib/context/ExecutionContext";

export default function Home() {
  return (
    <ExperimentProvider>
      <ExecutionProvider>
        <div className="flex h-screen flex-col" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          <Header />
          <EditorArea />
          <RunBar />
          <div className="bg-white sm:pb-4 pb-12" />
        </div>
      </ExecutionProvider>
    </ExperimentProvider>
  );
}
