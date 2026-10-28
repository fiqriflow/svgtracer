import Tracer from "@/components/Tracer";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-8 sm:px-6">
      <header className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Trace PNG ke SVG</h1>
        <p className="mt-1 text-sm text-mute">Unggah PNG, SVG langsung siap diunduh.</p>
      </header>
      <Tracer />
    </main>
  );
}
