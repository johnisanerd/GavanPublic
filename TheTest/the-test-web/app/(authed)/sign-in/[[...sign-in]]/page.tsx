import { SignIn } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

// Dark appearance tuned to the Palisade palette (Steel Grey surfaces,
// Science Green primary, Stone Green text).
const appearance = {
  variables: {
    colorBackground: "#29303e",
    colorPrimary: "#c7e09c",
    colorText: "#f2f3f0",
    colorTextSecondary: "rgba(242,243,240,0.62)",
    colorInputBackground: "#313947",
    colorInputText: "#f2f3f0",
    colorNeutral: "#f2f3f0",
    borderRadius: "8px",
  },
  elements: {
    card: { boxShadow: "none", border: "1px solid rgba(242,243,240,0.12)" },
    formButtonPrimary: { color: "#29303e", fontWeight: 500 },
  },
};

export default function SignInPage() {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100dvh",
        padding: "4rem 1.5rem",
      }}
    >
      <SignIn appearance={appearance} />
    </div>
  );
}
