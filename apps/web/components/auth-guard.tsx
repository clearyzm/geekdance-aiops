"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";

type User = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator";
  mustChangePassword: boolean;
};
const UserContext = createContext<User | null>(null);
const adminOnlyPaths = ["/members", "/automations"];

export function useUser() {
  return useContext(UserContext);
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("unauthorized");
        const data = (await response.json()) as { user: User };
        setUser(data.user);
        if (
          data.user.role !== "admin" &&
          adminOnlyPaths.some((path) => pathname.startsWith(path))
        )
          router.replace("/dashboard");
        else if (data.user.mustChangePassword && pathname !== "/settings")
          router.replace("/settings?changePassword=1");
      })
      .catch(() => router.replace("/login"))
      .finally(() => setLoading(false));
  }, [pathname, router]);
  if (loading)
    return (
      <div className="grid min-h-screen place-items-center bg-white">
        <div className="flex items-center gap-3 text-sm font-medium text-[#666a73]">
          <span className="h-3 w-3 animate-pulse rounded-full bg-[#e60012]" />
          正在进入运营中心…
        </div>
      </div>
    );
  if (!user) return null;
  return <UserContext.Provider value={user}>{children}</UserContext.Provider>;
}
