#!/usr/bin/env python3
"""
PDF Image Extractor — Zero AI Cost
Extracts all embedded images from a PDF with their exact positions.
Called from Node.js as a child process. Returns JSON to stdout.

Usage: python3 extractImages.py <pdf_path> <page_number_1based> <output_dir> <article_id>
"""
import sys
import os
import json

try:
    import fitz  # PyMuPDF
except ImportError:
    print(json.dumps({"error": "pymupdf not installed. Run: pip3 install pymupdf", "images": []}))
    sys.exit(1)

def extract_images(pdf_path, page_num_1based, output_dir, article_id):
    """Extract images from a single PDF page with their positions."""
    if not os.path.exists(pdf_path):
        return {"error": f"PDF not found: {pdf_path}", "images": []}
    
    os.makedirs(output_dir, exist_ok=True)
    
    doc = fitz.open(pdf_path)
    page_idx = page_num_1based - 1
    
    if page_idx < 0 or page_idx >= len(doc):
        doc.close()
        return {"error": f"Page {page_num_1based} out of range (total: {len(doc)})", "images": []}
    
    page = doc[page_idx]
    page_width = page.rect.width
    page_height = page.rect.height
    
    images_info = page.get_image_info(xrefs=True)
    extracted = []
    img_counter = 0
    
    for img in images_info:
        bbox = img['bbox']
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        
        # Skip tiny decorative elements (borders, lines, dots)
        if w < 40 or h < 40:
            continue
        
        # Skip very thin images (likely separators/lines)
        if w / h > 15 or h / w > 15:
            continue
        
        xref = img['xref']
        if xref == 0:
            continue
        
        try:
            pix = fitz.Pixmap(doc, xref)
            
            # Convert CMYK/Gray to RGB
            if pix.n > 4 or pix.n == 4:
                pix = fitz.Pixmap(fitz.csRGB, pix)
            
            # Save the extracted image
            filename = f"page-{page_num_1based}-crop-{img_counter}.png"
            filepath = os.path.join(output_dir, filename)
            pix.save(filepath)
            
            # Calculate normalized bounding box (0-1000 scale, matching Gemini format)
            norm_box = [
                round(bbox[1] / page_height * 1000),  # ymin
                round(bbox[0] / page_width * 1000),    # xmin
                round(bbox[3] / page_height * 1000),   # ymax
                round(bbox[2] / page_width * 1000)     # xmax
            ]
            
            # Calculate layout ratios for frontend rendering
            width_ratio = round(w / page_width, 3)
            left_ratio = round((bbox[0] + w / 2) / page_width, 3)
            top_ratio = round(bbox[1] / page_height, 3)
            
            crops_dir_name = f"crops-{article_id}"
            src = f"/uploads/images/{crops_dir_name}/{filename}"
            
            extracted.append({
                "id": img_counter,
                "src": src,
                "filepath": filepath,
                "box": norm_box,
                "layout": {
                    "widthRatio": width_ratio,
                    "leftRatio": left_ratio,
                    "topRatio": top_ratio
                },
                "originalSize": {
                    "width": pix.width,
                    "height": pix.height
                },
                "caption": ""
            })
            
            img_counter += 1
            
        except Exception as e:
            # Skip corrupted or unsupported image formats
            continue
    
    doc.close()
    
    return {
        "page": page_num_1based,
        "pageSize": {"width": round(page_width, 1), "height": round(page_height, 1)},
        "images": extracted,
        "count": len(extracted)
    }


if __name__ == "__main__":
    if len(sys.argv) < 5:
        print(json.dumps({"error": "Usage: extractImages.py <pdf_path> <page_num> <output_dir> <article_id>", "images": []}))
        sys.exit(1)
    
    pdf_path = sys.argv[1]
    page_num = int(sys.argv[2])
    output_dir = sys.argv[3]
    article_id = sys.argv[4]
    
    result = extract_images(pdf_path, page_num, output_dir, article_id)
    print(json.dumps(result))
