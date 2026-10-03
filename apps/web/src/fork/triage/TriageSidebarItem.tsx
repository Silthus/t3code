import { useNavigate } from "@tanstack/react-router";
import { ListChecksIcon } from "lucide-react";
import { useCallback } from "react";

import { SidebarUtilityItem } from "~/components/sidebar/SidebarChrome";
import { useSidebar } from "~/components/ui/sidebar";

export function TriageSidebarItem() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const openTriage = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/triage" });
  }, [isMobile, navigate, setOpenMobile]);
  return <SidebarUtilityItem icon={<ListChecksIcon />} label="Triage" onClick={openTriage} />;
}
