/** The web app root. Will hold the attention dashboard (r3 design). */
import { Button } from "@/components/ui/button";

export function App() {
  return (
    <main className="dark bg-background text-foreground flex min-h-screen flex-col items-center justify-center gap-3">
      <h1 className="text-2xl font-semibold">nod</h1>
      <p className="text-muted-foreground text-sm">The attention dashboard is not built yet.</p>
      <Button variant="outline" size="sm" asChild>
        <a href="https://github.com/FreshlyBrewedCode/nod">Repository</a>
      </Button>
    </main>
  );
}
