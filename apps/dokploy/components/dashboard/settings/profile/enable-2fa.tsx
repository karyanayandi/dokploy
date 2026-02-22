import { zodResolver } from "@hookform/resolvers/zod";
import copy from "copy-to-clipboard";
import { CopyIcon, DownloadIcon, Fingerprint, QrCode } from "lucide-react";
import QRCode from "qrcode";
import { useReducer } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
} from "@/components/ui/input-otp";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { authClient } from "@/lib/auth-client";
import { api } from "@/utils/api";

const PasswordSchema = z.object({
	password: z.string().min(8, {
		message: "Password is required",
	}),
	issuer: z.string().optional(),
});

const PinSchema = z.object({
	pin: z.string().min(6, {
		message: "Pin is required",
	}),
});

type TwoFactorSetupData = {
	qrCodeUrl: string;
	secret: string;
	totpURI: string;
};

type PasswordForm = z.infer<typeof PasswordSchema>;
type PinForm = z.infer<typeof PinSchema>;

export const USERNAME_PLACEHOLDER = "%username%";
export const DATE_PLACEHOLDER = "%date%";
export const BACKUP_CODES_PLACEHOLDER = "%backupCodes%";

export const backupCodeTemplate = `Dokploy - BACKUP VERIFICATION CODES

Points to note
--------------
# Each code can be used only once.
# Do not share these codes with anyone.

Generated codes
---------------
Username: ${USERNAME_PLACEHOLDER}
Generated on: ${DATE_PLACEHOLDER}


${BACKUP_CODES_PLACEHOLDER}
`;

// --- Reducer ---

type Enable2FAState = {
	data: TwoFactorSetupData | null;
	backupCodes: string[];
	isDialogOpen: boolean;
	step: "password" | "verify";
	isPasswordLoading: boolean;
	otpValue: string;
};

const enable2FAInitialState: Enable2FAState = {
	data: null,
	backupCodes: [],
	isDialogOpen: false,
	step: "password",
	isPasswordLoading: false,
	otpValue: "",
};

type Enable2FAAction =
	| { type: "OPEN_DIALOG" }
	| { type: "CLOSE_DIALOG" }
	| { type: "RESET_ON_CLOSE" }
	| { type: "SET_DATA"; payload: TwoFactorSetupData }
	| { type: "SET_BACKUP_CODES"; payload: string[] }
	| { type: "SET_STEP"; payload: "password" | "verify" }
	| { type: "SET_IS_PASSWORD_LOADING"; payload: boolean }
	| { type: "SET_OTP_VALUE"; payload: string };

function enable2FAReducer(
	state: Enable2FAState,
	action: Enable2FAAction,
): Enable2FAState {
	switch (action.type) {
		case "OPEN_DIALOG":
			return { ...state, isDialogOpen: true };
		case "CLOSE_DIALOG":
			return { ...state, isDialogOpen: false };
		case "RESET_ON_CLOSE":
			return { ...enable2FAInitialState };
		case "SET_DATA":
			return { ...state, data: action.payload };
		case "SET_BACKUP_CODES":
			return { ...state, backupCodes: action.payload };
		case "SET_STEP":
			// When transitioning to verify step, reset the OTP value
			return {
				...state,
				step: action.payload,
				otpValue: action.payload === "verify" ? "" : state.otpValue,
			};
		case "SET_IS_PASSWORD_LOADING":
			return { ...state, isPasswordLoading: action.payload };
		case "SET_OTP_VALUE":
			return { ...state, otpValue: action.payload };
		default:
			return state;
	}
}

export const Enable2FA = () => {
	const utils = api.useUtils();
	const { data: currentUser } = api.user.get.useQuery();
	const [state, dispatch] = useReducer(enable2FAReducer, enable2FAInitialState);
	const { data, backupCodes, isDialogOpen, step, isPasswordLoading, otpValue } =
		state;

	// Reset all state when dialog closes
	const handleDialogOpenChange = (open: boolean) => {
		if (!open) {
			dispatch({ type: "RESET_ON_CLOSE" });
			passwordForm.reset({ password: "", issuer: "" });
		} else {
			dispatch({ type: "OPEN_DIALOG" });
		}
	};

	const handleVerifySubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			const result = await authClient.twoFactor.verifyTotp({
				code: otpValue,
			});

			if (result.error) {
				if (result.error.code === "INVALID_TWO_FACTOR_AUTHENTICATION") {
					toast.error("Invalid verification code");
					return;
				}

				throw result.error;
			}

			if (!result.data) {
				throw new Error("No response received from server");
			}

			toast.success("2FA configured successfully");
			utils.user.get.invalidate();
			dispatch({ type: "RESET_ON_CLOSE" });
		} catch (error) {
			if (error instanceof Error) {
				const errorMessage =
					error.message === "Failed to fetch"
						? "Connection error. Please check your internet connection."
						: error.message;

				toast.error(errorMessage);
			} else {
				toast.error("Error verifying 2FA code", {
					description: error instanceof Error ? error.message : "Unknown error",
				});
			}
		}
	};

	const passwordForm = useForm<PasswordForm>({
		resolver: zodResolver(PasswordSchema),
		defaultValues: {
			password: "",
		},
	});

	const pinForm = useForm<PinForm>({
		resolver: zodResolver(PinSchema),
		defaultValues: {
			pin: "",
		},
	});

	const handlePasswordSubmit = async (formData: PasswordForm) => {
		dispatch({ type: "SET_IS_PASSWORD_LOADING", payload: true });
		try {
			const { data: enableData, error } = await authClient.twoFactor.enable({
				password: formData.password,
				issuer: formData.issuer,
			});

			if (!enableData) {
				throw new Error(error?.message || "Error enabling 2FA");
			}

			if (enableData.backupCodes) {
				dispatch({ type: "SET_BACKUP_CODES", payload: enableData.backupCodes });
			}

			if (enableData.totpURI) {
				const qrCodeUrl = await QRCode.toDataURL(enableData.totpURI);

				dispatch({
					type: "SET_DATA",
					payload: {
						qrCodeUrl,
						secret: enableData.totpURI.split("secret=")[1]?.split("&")[0] || "",
						totpURI: enableData.totpURI,
					},
				});

				dispatch({ type: "SET_STEP", payload: "verify" });
				toast.success("Scan the QR code with your authenticator app");
			} else {
				throw new Error("No TOTP URI received from server");
			}
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Error setting up 2FA",
			);
			passwordForm.setError("password", {
				message:
					error instanceof Error ? error.message : "Error setting up 2FA",
			});
		} finally {
			dispatch({ type: "SET_IS_PASSWORD_LOADING", payload: false });
		}
	};

	const handleDownloadBackupCodes = () => {
		if (!backupCodes || backupCodes.length === 0) {
			toast.error("No backup codes to download.");
			return;
		}

		const backupCodesFormatted = backupCodes
			.map((code, index) => ` ${index + 1}. ${code}`)
			.join("\n");

		const date = new Date();
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		const filename = `dokploy-2fa-backup-codes-${year}${month}${day}.txt`;

		const backupCodesText = backupCodeTemplate
			.replace(USERNAME_PLACEHOLDER, currentUser?.user?.email || "unknown")
			.replace(DATE_PLACEHOLDER, date.toLocaleString())
			.replace(BACKUP_CODES_PLACEHOLDER, backupCodesFormatted);

		const blob = new Blob([backupCodesText], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	const handleCopyBackupCodes = () => {
		const date = new Date();

		const backupCodesFormatted = backupCodes
			.map((code, index) => ` ${index + 1}. ${code}`)
			.join("\n");

		const backupCodesText = backupCodeTemplate
			.replace(USERNAME_PLACEHOLDER, currentUser?.user?.email || "unknown")
			.replace(DATE_PLACEHOLDER, date.toLocaleString())
			.replace(BACKUP_CODES_PLACEHOLDER, backupCodesFormatted);

		copy(backupCodesText);
		toast.success("Backup codes copied to clipboard");
	};

	return (
		<Dialog open={isDialogOpen} onOpenChange={handleDialogOpenChange}>
			<DialogTrigger asChild>
				<Button variant="ghost">
					<Fingerprint className="size-4 text-muted-foreground" />
					Enable 2FA
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>2FA Setup</DialogTitle>
					<DialogDescription>
						{step === "password"
							? "Enter your password to begin 2FA setup"
							: "Scan the QR code and verify with your authenticator app"}
					</DialogDescription>
				</DialogHeader>

				{step === "password" ? (
					<Form {...passwordForm}>
						<form
							id="password-form"
							onSubmit={passwordForm.handleSubmit(handlePasswordSubmit)}
							className="space-y-4"
						>
							<FormField
								control={passwordForm.control}
								name="password"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Password</FormLabel>
										<FormControl>
											<Input
												type="password"
												placeholder="Enter your password"
												{...field}
											/>
										</FormControl>
										<FormDescription>
											Enter your password to enable 2FA
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={passwordForm.control}
								name="issuer"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Issuer</FormLabel>
										<FormControl>
											<Input
												type="text"
												placeholder="Enter your issuer"
												{...field}
											/>
										</FormControl>
										<FormDescription>
											Use a custom issuer to identify the service you're
											authenticating with.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							<Button
								type="submit"
								className="w-full"
								isLoading={isPasswordLoading}
							>
								Continue
							</Button>
						</form>
					</Form>
				) : (
					<Form {...pinForm}>
						<form onSubmit={handleVerifySubmit} className="space-y-6">
							<div className="flex flex-col gap-6 justify-center items-center">
								{data?.qrCodeUrl ? (
									<>
										<div className="flex flex-col items-center gap-4 p-6 border rounded-lg">
											<QrCode className="size-5 text-muted-foreground" />
											<span className="text-sm font-medium">
												Scan this QR code with your authenticator app
											</span>
											{/** biome-ignore lint/performance/noImgElement: This is a valid use case for an img element */}
											<img
												src={data.qrCodeUrl}
												alt="2FA QR Code"
												className="rounded-lg w-48 h-48"
											/>
											<div className="flex flex-col gap-2 text-center">
												<span className="text-sm text-muted-foreground">
													Can't scan the QR code?
												</span>
												<span className="text-xs font-mono bg-muted p-2 rounded">
													{data.secret}
												</span>
											</div>
										</div>

										{backupCodes && backupCodes.length > 0 && (
											<div className="w-full space-y-3 border rounded-lg p-4">
												<div className="flex items-center justify-between">
													<h4 className="font-medium">Backup Codes</h4>
													<div className="flex items-center gap-2">
														<TooltipProvider>
															<Tooltip delayDuration={0}>
																<TooltipTrigger asChild>
																	<Button
																		type="button"
																		variant="outline"
																		size="icon"
																		onClick={handleCopyBackupCodes}
																	>
																		<CopyIcon className="size-4" />
																	</Button>
																</TooltipTrigger>
																<TooltipContent>
																	<p>Copy</p>
																</TooltipContent>
															</Tooltip>
														</TooltipProvider>

														<TooltipProvider>
															<Tooltip delayDuration={0}>
																<TooltipTrigger asChild>
																	<Button
																		type="button"
																		variant="outline"
																		size="icon"
																		onClick={handleDownloadBackupCodes}
																	>
																		<DownloadIcon className="size-4" />
																	</Button>
																</TooltipTrigger>
																<TooltipContent>
																	<p>Download</p>
																</TooltipContent>
															</Tooltip>
														</TooltipProvider>
													</div>
												</div>
												<div className="grid grid-cols-2 gap-2">
													{backupCodes.map((code, index) => (
														<code
															key={index}
															className="bg-muted p-2 rounded text-sm font-mono"
														>
															{code}
														</code>
													))}
												</div>
												<p className="text-sm text-muted-foreground">
													Save these backup codes in a secure place. You can use
													them to access your account if you lose access to your
													authenticator device.
												</p>
											</div>
										)}
									</>
								) : (
									<div className="flex items-center justify-center w-full h-48 bg-muted rounded-lg">
										<QrCode className="size-8 text-muted-foreground animate-pulse" />
									</div>
								)}
							</div>

							<div className="flex flex-col justify-center items-center">
								<FormLabel>Verification Code</FormLabel>
								<InputOTP
									maxLength={6}
									value={otpValue}
									onChange={(val) =>
										dispatch({ type: "SET_OTP_VALUE", payload: val })
									}
									autoComplete="off"
								>
									<InputOTPGroup>
										<InputOTPSlot index={0} />
										<InputOTPSlot index={1} />
										<InputOTPSlot index={2} />
										<InputOTPSlot index={3} />
										<InputOTPSlot index={4} />
										<InputOTPSlot index={5} />
									</InputOTPGroup>
								</InputOTP>
								<FormDescription>
									Enter the 6-digit code from your authenticator app
								</FormDescription>
							</div>

							<Button
								type="submit"
								className="w-full"
								isLoading={isPasswordLoading}
								disabled={otpValue.length !== 6}
							>
								Enable 2FA
							</Button>
						</form>
					</Form>
				)}
			</DialogContent>
		</Dialog>
	);
};
