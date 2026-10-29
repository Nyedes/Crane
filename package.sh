#!/bin/bash
# package.sh
# Zips extension files, excluding development artifacts, for Mozilla/Browser submission.

OUTPUT_XPI="skyscrapercity_opener.xpi"
OUTPUT_ZIP="skyscrapercity_opener.zip"

# Ensure Tailwind CSS is up to date if tailwindcss binary is present
if [ -x "./node_modules/.bin/tailwindcss" ]; then
    ./node_modules/.bin/tailwindcss -i ./input.css -o ./tailwind-built.css --minify
fi

# Remove old archives if they exist
rm -f "$OUTPUT_XPI" "$OUTPUT_ZIP"

# Package necessary files into both .xpi and .zip
FILES=(manifest.json background.js content.js popup.html popup.js options.html options.js tailwind-built.css icons/ README.md)

zip -r "$OUTPUT_XPI" "${FILES[@]}"
cp "$OUTPUT_XPI" "$OUTPUT_ZIP"

echo "--------------------------------------------------------"
echo "🎉 Extension packaged successfully into:"
echo "   - $OUTPUT_XPI"
echo "   - $OUTPUT_ZIP"
echo "--------------------------------------------------------"
