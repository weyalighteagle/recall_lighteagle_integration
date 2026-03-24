import { SignIn } from "@clerk/react";

export default function SignInPage() {
  return (
    <div style={{ display: "flex", justifyContent: "center", marginTop: "10vh" }}>
      <SignIn />
    </div>
  );
}
