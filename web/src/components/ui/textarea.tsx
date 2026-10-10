import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // max-h-[50vh] + overflow-y-auto：field-sizing-content 会随内容自动增高，若不封顶，
        // 长文本会把 textarea（及其所在弹窗/抽屉）撑出视口且无法滚动。封顶后超出部分在框内滚动。
        // 页面如需更矮/更高，用自定义 max-h 覆盖（twMerge 取后者）。
        "flex field-sizing-content max-h-[50vh] min-h-16 w-full overflow-y-auto rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
