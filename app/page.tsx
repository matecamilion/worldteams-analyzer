import { redirect } from "next/navigation";

// Hasta que exista el login, la entrada lleva directo al detector.
export default function Home() {
  redirect("/detector");
}
