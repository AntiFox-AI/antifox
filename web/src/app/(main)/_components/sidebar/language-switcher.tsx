"use client";

import { Check, Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LANGS, LANG_STORAGE_KEY } from "@/i18n/config";
import { cn } from "@/lib/utils";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();

  const pick = (code: string) => {
    void i18n.changeLanguage(code);
    if (typeof window !== "undefined") localStorage.setItem(LANG_STORAGE_KEY, code);
    if (typeof document !== "undefined") document.documentElement.lang = code;
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" aria-label={t("lang.switch")}>
          <Languages />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
        {LANGS.map((l) => (
          <DropdownMenuItem key={l.code} onClick={() => pick(l.code)} className="justify-between">
            {l.label}
            <Check className={cn("size-4", i18n.language === l.code ? "opacity-100" : "opacity-0")} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
