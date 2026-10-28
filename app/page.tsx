import Tracer from "@/components/Tracer";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Trace PNG ke SVG</h1>
        <p className="text-sm text-mute">Diproses di browser, file tidak diunggah.</p>
      </header>
      <Tracer />
    </main>
  );
}
