const TelegramBot = require("node-telegram-bot-api");
const config = require("./config.js");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const P = require("pino");
const bot = new TelegramBot(config.token, { polling: true });

const sessions = new Map();
const SESSIONS_DIR = "./sessions";
const ACTIVE_NUMBERS_FILE = "./sessions/active_numbers.json";

function createSessionDir(botNumber) {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  return SESSIONS_DIR;
}

function saveActiveNumbers(numbers) {
  const limitedNumbers = numbers.slice(0, 1);
  fs.writeFileSync(ACTIVE_NUMBERS_FILE, JSON.stringify(limitedNumbers));
}

function loadActiveNumbers() {
  try {
    if (fs.existsSync(ACTIVE_NUMBERS_FILE)) {
      const numbers = JSON.parse(fs.readFileSync(ACTIVE_NUMBERS_FILE));
      return numbers.slice(0, 1);
    }
  } catch (error) {
    console.error("Error loading active numbers:", error);
  }
  return [];
}

async function initializeWhatsAppConnections() {
  try {
    const activeNumbers = loadActiveNumbers();
    for (const botNumber of activeNumbers) {
      const sessionDir = createSessionDir(botNumber);
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: "silent" }),
        defaultQueryTimeoutMs: undefined,
      });

      await new Promise((resolve, reject) => {
        sock.ev.on("connection.update", async (update) => {
          const { connection, lastDisconnect } = update;
          if (connection === "open") {
            console.log(`BOT Number : ${botNumber} udah terkonek nih masbroo!`);
            sessions.set(botNumber, sock);
            const activeNumbers = loadActiveNumbers();
            if (!activeNumbers.includes(botNumber)) {
              activeNumbers.push(botNumber);
              saveActiveNumbers(activeNumbers);
            }
            resolve();
          } else if (connection === "close") {
            const shouldReconnect =
              lastDisconnect?.error?.output?.statusCode !==
              DisconnectReason.loggedOut;
            if (shouldReconnect) {
              console.log(`Mencoba menghubungkan ulang bot ${botNumber}...`);
              await initializeWhatsAppConnections();
            } else {
              reject(new Error("Koneksi ditutup"));
            }
          }
        });

        sock.ev.on("creds.update", saveCreds);
      });
    }
  } catch (error) {
    console.error(error);
  }
}

async function connectToWhatsApp(botNumber, chatId) {
  const activeNumbers = loadActiveNumbers();
  if (activeNumbers.length > 0) {
    await bot.sendMessage(
      chatId,
      `╭─────────────────
│    *BOT SUDAH TERHUBUNG*    
│────────────────
│ ❌ udah ada nomor yang terkonek masbroo!
│ 📱 Nomor: ${activeNumbers[0]}
╰─────────────────`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  let statusMessage = await bot
    .sendMessage(
      chatId,
      `╭─────────────────
│ Bot: ${botNumber}
│ Status: Check Dlu Nih...
╰─────────────────`,
      { parse_mode: "Markdown" }
    )
    .then((msg) => msg.message_id);

  const sessionDir = createSessionDir(botNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        const activeNumbers = loadActiveNumbers();
        const updatedNumbers = activeNumbers.filter((num) => num !== botNumber);
        saveActiveNumbers(updatedNumbers);
      }
      if (statusCode && statusCode >= 500 && statusCode < 600) {
        await bot.editMessageText(
          `╭─────────────────
│ Bot: ${botNumber}
│ Status: Sabar ya masbroo...
╰─────────────────`,
          {
            chat_id: chatId,
            message_id: statusMessage,
            parse_mode: "Markdown",
          }
        );
        await connectToWhatsApp(botNumber, chatId);
      } else {
        await bot.editMessageText(
          `╭─────────────────
│ Bot: ${botNumber}
│ Status: Failed Jirrr, coba lagi dah!
╰─────────────────`,
          {
            chat_id: chatId,
            message_id: statusMessage,
            parse_mode: "Markdown",
          }
        );
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (error) {
          console.error("Error deleting session:", error);
        }
      }
    } else if (connection === "open") {
      sessions.set(botNumber, sock);
      const activeNumbers = loadActiveNumbers();
      if (!activeNumbers.includes(botNumber)) {
        activeNumbers.push(botNumber);
        saveActiveNumbers(activeNumbers);
      }
      await bot.editMessageText(
        `╭─────────────────
│ Bot: ${botNumber}
│ Status: Aanjayyy Konek Success!
╰─────────────────`,
        {
          chat_id: chatId,
          message_id: statusMessage,
          parse_mode: "Markdown",
        }
      );
    } else if (connection === "connecting") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(botNumber);
          const formattedCode = code.match(/.{1,4}/g)?.join("-") || code;
          await bot.editMessageText(
            `╭─────────────────
│    *Nih Code Pairing nya*    
│────────────────
│ Bot: ${botNumber}
│ Kode: ${formattedCode}
╰─────────────────`,
            {
              chat_id: chatId,
              message_id: statusMessage,
              parse_mode: "Markdown",
            }
          );
        }
      } catch (error) {
        console.error("Error requesting pairing code:", error);
        await bot.editMessageText(
          `╭─────────────────
│    *ERROR NIH*    
│────────────────
│ Bot: ${botNumber}
│ Pesan: ${error.message}
╰─────────────────`,
          {
            chat_id: chatId,
            message_id: statusMessage,
            parse_mode: "Markdown",
          }
        );
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  return sock;
}

async function initializeBot() {
  console.log("╭─────────────────");
  console.log("│> @PRIMROSE_LOTUS");
  console.log("│────────────────");
  console.log("│> Base Whatsapp Bot");
  console.log("╰─────────────────");

  await initializeWhatsAppConnections();
}

initializeBot();

bot.on("message", async (msg) => {
  let sock;
  if (sessions.size > 0) {
    [_, sock] = Array.from(sessions.entries())[0];
  }
  const chatId = msg.chat.id;
  
  if (!msg.text) {
    bot.sendMessage(
      chatId,
      `╭─────────────────
│    *PESAN TIDAK VALID*    
│────────────────
│ ❌ Hanya bisa memproses pesan teks
╰─────────────────`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const command = msg.text.split(" ")[0].toLowerCase().replace("/", "");

  switch (command) {
    case "start":
      {
        bot.sendMessage(
          chatId,
          "Simple Base Telegram x WhatsApp with Case\nBy @QueeRuvaAiBeta\n\nType /menu for see all commands\n\nᴄʀᴇᴀᴛᴏʀ ʙʏ ɪᴄᴏɴɪᴄ ᴛᴇᴄʜ"
        );
      }
      break;
case "owner":
  {
    bot.sendMessage(
      chatId,
      "Welcome to ǫᴜᴇᴇɴ ʀᴜᴠᴀ ᴀɪ ʙᴇᴛᴀ\n\nA simple Telegram x WhatsApp integration bot.\n\nType /menu to view all available commands.\n\nDeveloped by ɪᴄᴏɴɪᴄ ᴛᴇᴄʜ\nFor support or inquiries, reach out to @QueeRuvaAiBeta."
    );
  }
  break;
    case "menu":
  {
    const menuText = `
╭━━━〔 *QUEEN RUVA AI BETA V1* 〕━━━┈⊷
┃★╭──────────────
┃★│  👤 ᴏᴡɴᴇʀ : *https://t.me/QueeRuvaAiBeta*
┃★│  🧭 ʙᴀɪʟᴇʏs : *Multi Device*
┃★│ 👨‍💻 ᴛʏᴘᴇ : *ɴᴏᴅᴇᴊs*
┃★│ 🌐 ᴘʟᴀᴛғᴏʀᴍ : *termux*
┃★│ 🤖 ᴘʀɪғɪx : *[]*
┃★│ 🚀 ᴠᴇʀsɪᴏɴ : *1.0.0 Bᴇᴛᴀ* 
┃★│ ⏱️ ᴀʟᴡᴀʏs ᴏɴʟɪɴᴇ : ᴛʀᴜᴇ
┃★│ 
┃★│ 
┃★│    
┃★╰──────────────
╰━━━━━━━━━━━━━━━┈⊷
╭━━━〔INFOR MENU〕━━━┈⊷
┃★╭──────────────
┃★│ ᴀʙᴏᴜᴛ-ᴏᴡɴᴇʀ
┃★│ ɢʀᴇᴀᴛɪɴɢ
┃★│ ᴛɪᴍᴇ
┃★│ ɪɴғᴏʀ
┃★│ ɪɴғᴏʀᴍᴀᴛɪᴏɴ
┃★│ sᴘᴏᴛɪғʏ
┃★│ ʀᴜᴠᴀ-ᴅᴀᴡʟᴏᴀᴅ
┃★│ ɢᴀᴍᴇ
┃★│ ʟʏʀɪᴄs
┃★│ ᴀᴘᴋ
┃★│ ᴡᴇʙsɪᴛᴇ
┃★│ ᴄʜᴀɴɴᴇʟ 
┃★│ ᴛᴀɢᴀᴅᴍɪɴ
┃★│ ᴡʏʀ
┃★│ ᴍᴇᴍᴇ 
┃★│ ᴛʀᴀɴsʟᴀᴛᴇ
┃★│ ᴛʀᴀɴsʟᴀᴛᴇ2 
┃★│ ᴍᴏᴠɪᴇ  
┃★│ ɢɪᴛʜᴜʙ  
┃★│ ʟɪᴄᴇɴsᴇ
┃★│ sᴏᴜɴᴅᴄʟᴏᴜᴅ
╭━━━〔OTHER MENU (2)〕━━━┈⊷
┃★╭──────────────
┃★│ ᴛʀᴀɴsʟᴀᴛᴇ
┃★│ ʀᴜɴᴛɪᴍᴇ
┃★│ ᴍᴇᴅɪᴀғɪʀᴇ
┃★│ ᴀɴɪᴍᴇ
┃★│ ᴜᴘᴅᴀᴛᴇ
┃★│ ʙʀᴏᴀᴅᴄᴀsᴛ
┃★│ sᴛᴇᴀʟ 
┃★│ ᴅᴀᴡɴʟᴏᴀᴅ-ғɪʟᴇ
┃★│ ɴᴇᴡ-ᴠᴇʀsɪᴏɴ
┃★│ ʜᴏsᴛɪɴɢ
┃★│ sᴇᴛᴇxɪғ       
┃★│ ɢɪᴛᴄʟᴏɴᴇ
┃★╰──
╭━━━〔CHATGPT MENU〕━━━┈⊷
┃★╭──────────────
┃★│ sɪᴍɪ
┃★│ ᴅᴇᴇᴘsᴇᴇᴋ
┃★│ ᴄʜᴀᴛʙᴏᴛ
┃★│ ɢᴘᴛ3
┃★│ ɢᴘᴛ4
┃★│ ɢᴘᴛᴏ4
┃★│ ᴄʟᴀᴜᴅᴇ
┃★│ ʀᴇᴍᴇɴɪ
┃★│ ʀᴜᴠᴀ
┃★│ ɢᴇᴍᴍᴀ
┃★│ ᴀɪ
┃★│ ɪɪᴀᴍᴀ
┃★│ gemini
┃★╰──
╭━━━〔AI IMG MENU〕━━━┈⊷
┃★╭──────────────
┃★│ ʙɪɴɢ
┃★│ ᴀɴɪᴍᴇ
┃★│ ɪᴍɢ
┃★│ ᴘɪxᴀʙᴀʏ
┃★│ ɪᴍᴀɢᴇ
┃★│ ᴡᴀʟʟᴘᴀᴘᴇʀ
┃★│ ᴘɪɴᴛᴇʀᴇsᴛ
┃★╰──
╭━━━〔MEDIA MENU〕━━━┈⊷
┃★╭──────────────
┃★│ ᴡɪᴋɪᴘᴇᴅɪᴀ
┃★│ ᴡɪᴋɪᴘᴇᴅɪᴀ2
┃★│ ᴡᴇᴀᴛʜᴇʀ
┃★│ ᴡᴇᴀᴛʜᴇʀ2
┃★│ ʟʏʀɪᴄs
┃★│ ʟʏʀɪᴄs2
┃★│ ǫᴜᴏᴛᴇs
┃★│ ǫᴜᴏᴛᴇs2
┃★│ ǫᴜᴏᴛᴇs3
┃★│ ǫᴜᴏᴛᴇs4
┃★│ ᴀɴɪᴍᴇ
┃★│ sᴏɴɢ
┃★│ ᴠɪᴅᴇᴏ
┃★╰──
╭━━━〔OTHER MENU〕━━━┈⊷
┃★╭──────────────
┃★│ ᴛʀᴀɴsʟᴀᴛᴇ
┃★│ ʀᴜɴᴛɪᴍᴇ
┃★│ ᴍᴇᴅɪᴀғɪʀᴇ
┃★│ ᴀɴɪᴍᴇ
┃★│ ᴜᴘᴅᴀᴛᴇ
┃★│ ʜᴏsᴛɪɴɢ
┃★│ sᴇᴛᴇxɪғ       
┃★│ ɢɪᴛᴄʟᴏɴᴇ
╰━━━〔 END MENU 〕━━━┈⊷
    `;
    bot.sendMessage(chatId, menuText, { parse_mode: "Markdown" });
  }
case 'fact':
{
    try {
        // Construct the API URL for the fact
        const url = 'https://api.popcat.xyz/fact';
        console.log('Sending request to API:', url); // Log the API URL

        // Fetch the fact from the API
        const response = await fetch(url);
        console.log('API Response Status:', response.status); // Log the response status

        // Check if the response is OK (status code 200-299)
        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }

        // Parse the JSON response
        const jsonData = await response.json();
        console.log('Parsed JSON Data:', jsonData); // Log the parsed JSON

        // Handle the API response
        if (jsonData && jsonData.fact) {
            // Send the random fact back to the Telegram chat
            bot.sendMessage(chatId, `*Here's a random fact* ➪ ${jsonData.fact}\nᴄʀᴇᴀᴛᴏʀ ʙʏ ɪᴄᴏɴɪᴄ ᴛᴇᴄʜ`);
        } else {
            bot.sendMessage(chatId, 'Sorry, I couldn\'t fetch a fact right now.');
        }
    } catch (error) {
        console.error('Error fetching fact:', error); // Log the full error
        bot.sendMessage(chatId, 'An error occurred while fetching the fact. Please try again later.');
    }
    break;
}
  break;
  case 'quotes':
case 'quote': {
    try {
        // Construct the API URL
        const url = 'https://apis.davidcyriltech.my.id/random/quotes';
        console.log('Sending request to API:', url); // Log the API URL

        // Fetch the quote from the API
        const response = await fetch(url);
        console.log('API Response Status:', response.status); // Log the response status

        // Check if the response is OK (status code 200-299)
        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }

        // Parse the JSON response
        const jsonData = await response.json();
        console.log('Parsed JSON Data:', jsonData); // Log the parsed JSON

        // Handle the API response
        if (jsonData.response && jsonData.response.quote && jsonData.response.author) {
            // Send the quote to the Telegram chat
            bot.sendMessage(chatId, `♻️ Author: ${jsonData.response.author}\n♻️ Quote: "${jsonData.response.quote}"`);
        } else {
            // If the expected fields aren't found, send an error message
            bot.sendMessage(chatId, '♻️ Sorry, I couldn\'t fetch a quote at the moment.');
        }
    } catch (error) {
        console.error('Error fetching quote:', error); // Log the full error
        bot.sendMessage(chatId, '♻️ An error occurred while fetching the quote. Please try again later.');
    }
    break;
}

    case "pairing": {
      const input = msg.text.split(" ");

      if (input.length !== 2) {
        bot.sendMessage(
          chatId,
          `╭─────────────────
│    *SALAH KOCAK!*    
│────────────────
│ ℹ️ Gunakan format:
│ /pairing 6283136299177
╰─────────────────`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      const botNumber = input[1].replace(/[^0-9]/g, "");

      if (botNumber.length < 7) {
        bot.sendMessage(
          chatId,
          `╭─────────────────
│    *NOMOR TIDAK VALID*    
╰─────────────────`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      if (sessions.size > 0) {
        bot.sendMessage(
          chatId,
          `╭─────────────────
│    *BOT NYA UDAH KONEK!*    
│────────────────
│ ❌ Sudah ada bot yang terhubung
╰─────────────────`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      try {
        connectToWhatsApp(botNumber, chatId);
      } catch (error) {
        console.error("Error in pairing:", error);
        bot.sendMessage(
          chatId,
          `╭─────────────────
│    *GAGAL TERHUBUNG*    
│────────────────
│ ❌ Terjadi kesalahan
│ 🔄 Silakan coba lagi
╰─────────────────`,
          { parse_mode: "Markdown" }
        );
      }
      break;
    }

    case "send": {
      const input = msg.text.split(" ");

      if (input.length !== 2) {
        bot.sendMessage(
          chatId,
          `╭─────────────────
│    *FORMAT NYA SALAH KOCAK!*    
│────────────────
│ ❌ Format tidak sesuai
│ ℹ️ Gunakan format:
│ /send 6283136299177
╰─────────────────`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      if (!sock) {
        bot.sendMessage(
          chatId,
          `╭─────────────────
│    *Gagal Jirr*    
│────────────────
│ ❌ Gk ada bot yang terkonek cok!
│ ℹ️ Silakan hubungkan terlebih dahulu
│ dengan command /pairing
╰─────────────────`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      const targetNumber = input[1].replace(/[^0-9]/g, "");

      try {
        const jid = `${targetNumber}@s.whatsapp.net`;

        await sock.sendMessage(jid, {
          text: "PL TESTING!",
        });

        bot.sendMessage(
          chatId,
          `╭─────────────────
│    *Anjayy Success!*    
│────────────────
│ ✅ Message Sent
│ 📱 To: ${targetNumber}
╰─────────────────`,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        console.error("Error sending message:", error);
        bot.sendMessage(
          chatId,
          `╭─────────────────
│    *FAILED*    
│────────────────
│ ❌ Failed to send message
│ 🔄 Please try again
╰─────────────────`,
          { parse_mode: "Markdown" }
        );
      }
      break;
    }

    default:
      bot.sendMessage(
        chatId,
        `╭─────────────────
│    *COMMAND NOT FOUND*    
│────────────────
│ ❌ Command not found
│ ℹ️ Type /menu to see
│ available commands
╰─────────────────`,
        { parse_mode: "Markdown" }
      );
  }
});
