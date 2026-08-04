import * as React from "react"
import { Slot as SlotPrimitive } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-gray-600 focus-visible:ring-gray-600/50 focus-visible:ring-[3px] aria-invalid:ring-red-800/20 dark:aria-invalid:ring-red-800/40 aria-invalid:border-red-800",
  {
    variants: {
      variant: {
        default: "bg-gray-1000 text-background-100 hover:bg-gray-1000/90",
        destructive:
          "bg-red-800 text-white hover:bg-red-800/90 focus-visible:ring-red-800/20 dark:focus-visible:ring-red-800/40 dark:bg-red-800/60",
        outline:
          "border bg-background-100 shadow-xs hover:bg-gray-100 hover:text-gray-1000 dark:bg-gray-alpha-400/30 dark:border-gray-alpha-400 dark:hover:bg-gray-alpha-400/50",
        secondary:
          "bg-gray-100 text-gray-1000 hover:bg-gray-100/80",
        ghost:
          "hover:bg-gray-100 hover:text-gray-1000 dark:hover:bg-gray-100/50",
        link: "text-gray-1000 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? SlotPrimitive.Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
