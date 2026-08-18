export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div>
        {eyebrow && (
          <div className="mb-2 text-xs font-bold uppercase tracking-[.18em] text-[#e60012]">
            {eyebrow}
          </div>
        )}
        <h1 className="text-3xl font-bold tracking-[-.04em] text-[#17171a] sm:text-[34px]">
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#666a73]">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}
