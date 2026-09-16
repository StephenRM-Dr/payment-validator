import { notFound } from "next/navigation";
import VisorApiDocs from "./visor";

// La documentación describe todas las rutas, cabeceras de autenticación y contratos de
// la API: útil en desarrollo, innecesaria de exponer en producción. Se publica solo si
// se activa expresamente con API_DOCS_PUBLICAS=true.
export default function ApiDocsPage() {
  const habilitada = process.env.API_DOCS_PUBLICAS === "true" || process.env.NODE_ENV !== "production";
  if (!habilitada) notFound();

  return <VisorApiDocs />;
}
