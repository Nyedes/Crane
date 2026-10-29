#!/bin/bash
# package.sh
# Zips extension files, excluding development artifacts, for Mozilla submission.

OUTPUT_ZIP="skyscrapercity_opener.xpi"

# Remove old xpi if it exists
if [ -f "$OUTPUT_ZIP" ]; then
    rm "$OUTPUT_ZIP"
fi

# Package necessary files
zip -r "$OUTPUT_ZIP" manifest.json background.js content.js popup.html popup.js options.html options.js tailwind-built.css icons/ README.md

echo "--------------------------------------------------------"
echo "🎉 Extension packaged successfully into: $OUTPUT_ZIP"
echo "--------------------------------------------------------"
