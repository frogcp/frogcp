// shadcn/ui primitives (new-york style, CSS variables, neutral base; see
// components.json), adjusted for this SPA's `@` alias and its own `useTheme`
// (see `@/lib/theme`) instead of `next-themes`.
export { Button, buttonVariants } from "./button";
export { Badge, badgeVariants } from "./badge";
export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent } from "./card";
export { Input } from "./input";
export { Select } from "./select";
export { Label } from "./label";
export { Switch } from "./switch";
export { Separator } from "./separator";
export { Skeleton } from "./skeleton";
export { Avatar, AvatarImage, AvatarFallback, AvatarBadge, AvatarGroup, AvatarGroupCount } from "./avatar";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu";
export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption } from "./table";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./tooltip";
export { Toaster } from "./sonner";

// frogCP-specific components, built for this admin's schema-driven (not
// closed-enum) data. See each file's doc comment.
export { StatusPill, roleForValue } from "./StatusPill";
export type { StatusRole, StatusPillProps } from "./StatusPill";
export { CopyField } from "./CopyField";
export type { CopyFieldProps } from "./CopyField";
export { FrogMark } from "./icons";
