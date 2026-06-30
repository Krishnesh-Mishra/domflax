import { FlattenDemo } from '@/components/FlattenDemo';
import { CompressDemo } from '@/components/CompressDemo';
import { ListDemo } from '@/components/ListDemo';
import { AsyncDemo } from '@/components/AsyncDemo';

// This page is an async Server Component (App Router). It renders four demos that exercise the
// domflax webpack adapter at build time:
//   1. Flatten   — inert wrappers (empty / display:contents) collapse; flex-centering preserved.
//   2. Compress  — verbose Tailwind class sets shrink (incl. a dynamic-child element).
//   3. List      — `.map(...)` rows ARE optimized in 0.1.1; keys/data preserved.
//   4. Async     — an awaited data fetch is left untouched.
export default async function Home() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      {/* PRESERVED: a flex-centering wrapper around the header. It establishes the
          header's layout context, so domflax conservatively keeps it (see Roadmap). */}
      <div className="flex items-center justify-center">
        <header className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">domflax</h1>
          <p className="mt-2 text-slate-500">
            Next.js + Tailwind, optimized at build time by the domflax webpack adapter.
          </p>
        </header>
      </div>

      <div className="mt-10 flex flex-col gap-6">
        <FlattenDemo />
        <CompressDemo />
        <ListDemo />
        {/* Server Component with an async data fetch. */}
        <AsyncDemo />
      </div>
    </main>
  );
}
