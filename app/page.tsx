import { redirect } from "next/navigation";

// La entrada lleva al detector; el guard redirige a /login o /video si hace falta.
export default function Home() {
  redirect("/detector");
}
