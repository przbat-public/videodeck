# Chrome extension installation guide

## Step 0: Build the extension (required)

The extension source is TypeScript in `src/`. Chrome loads the generated
`*.js` files, so before the first install (and after every code change):

```bash
cd chrome-extension
npm install
npm run build
```

## Step 1: Icons (optional)

The repo already ships icons in `icons/` (`icon16.png`, `icon48.png`,
`icon128.png`). To rebrand:

- Option A: open `create-icons.html` in Chrome. The icons are generated and
  downloaded to your Downloads folder; move them to `chrome-extension/icons/`.
- Option B: create your own 16x16, 48x48 and 128x128 PNGs in any graphics
  editor and save them to `chrome-extension/icons/`.

If you remove the icons, Chrome falls back to a default icon. The extension
keeps working.

## Step 2: Install the extension

1. **Open Chrome** and go to the extensions page:

   ```
   chrome://extensions/
   ```

   Or: Chrome menu (three dots, top right) → **Extensions** → **Manage
   extensions**.

2. **Enable developer mode:** toggle **"Developer mode"** in the top right
   corner to ON.

3. **Load the extension:**
   - Click **"Load unpacked"**
   - In the folder picker go to:
     ```
     /Users/<user>/Projects/video-search-app/chrome-extension
     ```
   - Select the `chrome-extension` folder and click **"Select"**.

4. **Verify the installation:**
   - The extension should appear on the list
   - Its icon should appear in the Chrome toolbar (next to the URL bar)

## Step 3: Configure the extension

1. **Open the options:**
   - Right-click the extension icon in the toolbar and choose **"Options"**

   OR:

   - Go to `chrome://extensions/`
   - Find the "Video Downloader" extension
   - Click **"Details"**
   - Click **"Extension options"**

2. **Fill in the settings:**
   - **Server URL:** the video-search-app server URL
     - Example: `http://localhost:3001`
     - Make sure the server is running!

   - **Folder path:** the folder videos should be saved to
     - Example: `/Users/<user>/Videos/youtube`
     - **IMPORTANT:** this path must be listed in the server's
       `VIDEOS_FOLDER_PATH` environment variable!

   - **API token (optional):** fill in only when the server has `API_TOKEN`
     set, provide the same value (sent as `Authorization: Bearer`).

3. **Test the connection:**
   - Click **"Test connection"**
   - On success you will see: "Connection to the server works!"
   - On failure check:
     - whether the server is running
     - whether the URL is correct
     - whether the server has CORS enabled

4. **Save the settings:**
   - Click **"Save"**
   - A confirmation message appears

## Step 4: Use the extension

1. **Open a page with a video:**
   - Go to YouTube or another page with a video
   - Example: `https://www.youtube.com/watch?v=VIDEO_ID`

2. **Click the extension icon:**
   - In the Chrome toolbar, click the extension icon
   - A popup with the video info should appear

3. **Download the video:**
   - Click **"Download video"**
   - The progress is shown live in the popup
   - A success message appears when finished

## Troubleshooting

### The extension does not appear on the list

- Make sure you selected the right folder (`chrome-extension`, not its
  contents)
- Make sure `manifest.json` is in the `chrome-extension` folder

### "Failed to load extension" error

- Check the error console in `chrome://extensions/` (click "Details" →
  "Errors")
- Make sure all files are present
- Make sure `manifest.json` is valid

### "No video found on this page"

- Make sure you are on a page with a video (e.g. YouTube)
- Refresh the page and try again
- Check whether the content script is loaded (DevTools → Console)

### Server connection error

- Check whether the server is running
- Check whether the server URL is correct
- Check whether the server has CORS enabled (it uses `cors()`)
- Check whether `folderPath` is in the server's `VIDEOS_FOLDER_PATH`

### Downloading does not work

- Check whether the server has `yt-dlp` installed
- Check the server logs in the terminal
- Check whether the folder path exists and has the right permissions

## Requirements

- Chrome 88 or newer (Manifest V3)
- The video-search-app server must be running
- The folder path must be in the server's `VIDEOS_FOLDER_PATH`
- The server must have CORS enabled
