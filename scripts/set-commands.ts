import { setMyCommandsBody } from "../src/core/commands.js";
import { telegramCall } from "./telegram-call.js";

await telegramCall("setMyCommands", setMyCommandsBody());
