"use client";

import { SiV0 } from "@icons-pack/react-simple-icons";
import { Button } from "@vercel/geistdocs/components/button";
import { ButtonGroup } from "@vercel/geistdocs/components/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vercel/geistdocs/components/dropdown-menu";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ExampleActionsProps {
  readonly downloadUrl: string;
  readonly prompt: string;
  readonly source: string;
  readonly v0Url: string;
}

type CopiedAction = "prompt" | "source";

interface MenuItemContentProps {
  readonly description: string;
  readonly icon: React.ReactNode;
  readonly title: string;
}

function MenuItemContent({ description, icon, title }: MenuItemContentProps) {
  return (
    <span className="grid w-full grid-cols-[20px_minmax(0,1fr)] items-center gap-3 text-left">
      <span className="flex size-5 items-center justify-center text-gray-900">{icon}</span>
      <span className="flex min-w-0 flex-col items-start gap-0.5">
        <span className="text-gray-1000 text-label-14">{title}</span>
        <span className="text-copy-13 text-gray-900">{description}</span>
      </span>
    </span>
  );
}

export function ExampleActions({ downloadUrl, prompt, source, v0Url }: ExampleActionsProps) {
  const [copied, setCopied] = useState<CopiedAction | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async (action: CopiedAction, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(action);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(null), 2000);
  };

  const promptCopied = copied === "prompt";

  return (
    <ButtonGroup>
      <Button
        aria-label={promptCopied ? "Prompt copied" : "Copy prompt"}
        onClick={() => void copy("prompt", prompt)}
        size="sm"
        type="button"
        variant="outline"
      >
        {promptCopied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
        <span className="relative inline-block">
          <span className="invisible">Copy prompt</span>
          <span className="absolute inset-0">{promptCopied ? "Copied" : "Copy prompt"}</span>
        </span>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label="Example actions" size="icon-sm" type="button" variant="outline">
            <ChevronDownIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[min(320px,calc(100vw-2rem))] rounded-xl bg-background-100 p-1 shadow-(--ds-shadow-menu)"
          sideOffset={8}
        >
          <DropdownMenuItem asChild className="h-auto w-full p-2">
            <button onClick={() => void copy("prompt", prompt)} type="button">
              <MenuItemContent
                description="Copy the pull command and agent instructions"
                icon={copied === "prompt" ? <CheckIcon /> : <CopyIcon />}
                title={copied === "prompt" ? "Prompt copied" : "Copy prompt"}
              />
            </button>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="h-auto w-full p-2">
            <button onClick={() => void copy("source", source)} type="button">
              <MenuItemContent
                description="Copy every source file as Markdown"
                icon={copied === "source" ? <CheckIcon /> : <FileTextIcon />}
                title={copied === "source" ? "Source copied" : "Copy source"}
              />
            </button>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="h-auto w-full p-2">
            <a href={v0Url} rel="noopener noreferrer" target="_blank">
              <MenuItemContent
                description="Start a v0 chat with the example files"
                icon={<SiV0 aria-hidden="true" className="size-4" />}
                title="Open in v0"
              />
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="h-auto w-full p-2">
            <a download href={downloadUrl}>
              <MenuItemContent
                description="Download the complete source as a ZIP"
                icon={<DownloadIcon />}
                title="Download as ZIP"
              />
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <span aria-live="polite" className="sr-only">
        {copied === "prompt" ? "Prompt copied" : copied === "source" ? "Source copied" : ""}
      </span>
    </ButtonGroup>
  );
}
