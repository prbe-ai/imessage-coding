"use client";

/**
 * Delete-account confirmation modal.
 *
 * Before destroying anything it surfaces the uninstall one-liner (the same
 * CommandBlock the Integrations page uses) so the user can clean up their paired
 * machines first — deleting the account drops the device tokens server-side but
 * can't touch the local plugin/alias on each machine. The destructive confirm
 * calls POST /api/account/delete, which removes ALL account data and the Better
 * Auth identity, then we bounce to /sign-in.
 */

import { useCallback, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CommandBlock } from "@/components/command-block";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { deleteAccount } from "@/lib/api/account";
import { UNINSTALL_COMMAND } from "@/lib/uninstall";
import { extractError } from "@/lib/utils";

export function DeleteAccountDialog() {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const onConfirm = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteAccount();
      // The session is already destroyed server-side; hard-navigate to sign-in.
      window.location.replace("/sign-in");
    } catch (err) {
      setDeleting(false);
      toast.error(extractError(err, "Couldn't delete your account."));
    }
  }, [deleting]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't let the user dismiss mid-delete.
        if (deleting) return;
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="destructive">
          <Trash2 className="size-4" aria-hidden="true" />
          Delete account
        </Button>
      </DialogTrigger>

      <DialogContent showCloseButton={!deleting}>
        <DialogHeader>
          <DialogTitle>Delete your account</DialogTitle>
          <DialogDescription>
            This permanently deletes your linked number, paired devices, sessions,
            and message history. It can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-on-surface-variant">
            First, run the uninstall command on each paired machine to remove the
            local plugin and settings. Deleting your account drops the device
            tokens here, but only the uninstall script reverts a machine.
          </p>
          <CommandBlock
            label="Uninstall command"
            icon={<Trash2 className="size-3" aria-hidden="true" />}
            command={UNINSTALL_COMMAND}
            copyToastLabel="Copied uninstall command"
          />
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={deleting}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void onConfirm()}
            disabled={deleting}
          >
            {deleting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="size-4" aria-hidden="true" />
            )}
            {deleting ? "Deleting…" : "Delete everything"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
