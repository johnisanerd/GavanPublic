interface ModelIconProps {
  modelId: string;
  className?: string;
}

export default function ModelIcon({ modelId, className = "h-5 w-5" }: ModelIconProps) {
  const provider = modelId.split(":")[0];

  switch (provider) {
    case "openai":
      return (
        <div
          className={`flex items-center justify-center rounded ${className} bg-green-600 text-white font-bold text-[10px]`}
        >
          O
        </div>
      );
    case "anthropic":
      return (
        <div
          className={`flex items-center justify-center rounded ${className} bg-orange-500 text-white font-bold text-[10px]`}
        >
          A
        </div>
      );
    case "grok":
      return (
        <div
          className={`flex items-center justify-center rounded ${className} bg-gray-900 text-white font-bold text-[10px]`}
        >
          X
        </div>
      );
    default:
      return (
        <div
          className={`flex items-center justify-center rounded ${className} bg-gray-500 text-white font-bold text-[10px]`}
        >
          ?
        </div>
      );
  }
}
