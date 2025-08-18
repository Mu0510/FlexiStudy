'use client';
import dynamic from "next/dynamic";

const RescueConsoleApp = dynamic(
  () => import("@/components/rescue-console/RescueConsoleApp"),
  { ssr: false }
);

export default function Page() {
  return <RescueConsoleApp />;
}