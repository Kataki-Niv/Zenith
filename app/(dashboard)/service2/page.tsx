"use client";

import { Suspense } from "react";
import FuturePotentialPage from "./FuturePotentialPage";

function Service2Content() {
  return <FuturePotentialPage />;
}

export default function Service2Page() {
  return (
    <Suspense fallback={null}>
      <Service2Content />
    </Suspense>
  );
}
