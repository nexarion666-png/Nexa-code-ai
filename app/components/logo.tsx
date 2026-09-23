export function NexaMark({ small = false }: { small?: boolean }) {
  return (
    <div className={`relative grid place-items-center ${small ? 'h-9 w-9' : 'h-12 w-12'}`} aria-hidden="true">
      <div className="absolute inset-1 rotate-45 rounded-[13px] bg-gradient-to-br from-fuchsia-500 via-violet-500 to-indigo-500 opacity-95 blur-[1px]" />
      <div className="relative h-[58%] w-[58%] rotate-45 rounded-[8px] border-[5px] border-white/90 bg-[#09090b] shadow-[0_0_22px_rgba(139,92,246,.75)]" />
    </div>
  );
}
