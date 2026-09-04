import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";

export default function SignUpPage() {
  return (
    <Suspense>
      <AuthForm flow="signUp" />
    </Suspense>
  );
}
