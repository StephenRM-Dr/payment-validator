"use client";

import dynamic from "next/dynamic";
import spec from "./openapi.json";
import "swagger-ui-react/swagger-ui.css";

// Cargamos de forma dinámica para evitar errores de renderizado en el servidor (SSR)
const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

export default function VisorApiDocs() {
  return (
    <div style={{ background: "#fff", minHeight: "100vh", padding: "20px" }}>
      <SwaggerUI spec={spec} />
    </div>
  );
}
