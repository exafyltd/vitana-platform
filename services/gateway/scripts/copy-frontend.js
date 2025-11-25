const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src/frontend/command-hub');
const destDir = path.join(__dirname, '../dist/frontend/command-hub');

console.log(`Copying frontend files from ${srcDir} to ${destDir}...`);

function copyDir(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    let entries = fs.readdirSync(src, { withFileTypes: true });

    for (let entry of entries) {
        let srcPath = path.join(src, entry.name);
        let destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

if (fs.existsSync(srcDir)) {
    copyDir(srcDir, destDir);
    console.log('Frontend files copied successfully.');
} else {
    console.error(`Source directory not found: ${srcDir}`);
    process.exit(1);
}
