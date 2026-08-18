import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import * as React from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const buttonVariants = cva(
  "focus-ring inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-45",
  {
    variants: {
      variant: {
        primary:
          "bg-[#e60012] text-white shadow-[0_8px_20px_rgba(230,0,18,.18)] hover:bg-[#c90010]",
        secondary:
          "border border-[#dedee3] bg-white text-[#17171a] hover:border-[#b9b9c2] hover:bg-[#fafafa]",
        ghost: "text-[#666a73] hover:bg-[#f1f1f3] hover:text-[#17171a]",
        danger: "bg-[#17171a] text-white hover:bg-black",
      },
    },
    defaultVariants: { variant: "primary" },
  },
);

export function Button({
  className,
  variant,
  asChild = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp className={cn(buttonVariants({ variant }), className)} {...props} />
  );
}

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("gd-card", className)} {...props} />;
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "red" | "green" | "amber";
}) {
  const tones = {
    neutral: "bg-[#f1f1f3] text-[#666a73]",
    red: "bg-[#fff1f2] text-[#c40010]",
    green: "bg-[#edf8f1] text-[#187844]",
    amber: "bg-[#fff6df] text-[#8a5c00]",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold text-[#29292e]">
      {label}
      {children}
      {hint && (
        <span className="text-xs font-normal text-[#85858e]">{hint}</span>
      )}
    </label>
  );
}

export const inputClass =
  "focus-ring h-11 w-full rounded-xl border border-[#dedee3] bg-white px-3.5 text-sm text-[#17171a] placeholder:text-[#a2a2aa] hover:border-[#c6c6cc] focus:border-[#e60012]";
