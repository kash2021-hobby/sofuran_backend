#!/usr/bin/env python3
"""
PDF Layout Extractor (Zero AI Cost)
Extracts both text and images from a PDF page, determines formatting based on font size/weight,
and reconstructs the layout in reading order (top-to-bottom).
Returns the structured JSON expected by the frontend.
"""
import sys
import os
import json
import re

try:
    import fitz  # PyMuPDF
except ImportError:
    print(json.dumps({"error": "pymupdf not installed."}))
    sys.exit(1)

def is_bold(font_name):
    return 'bold' in font_name.lower() or 'black' in font_name.lower()

def extract_layout(pdf_path, page_num_1based, output_dir, article_id, page_type):
    if not os.path.exists(pdf_path):
        return {"error": f"PDF not found: {pdf_path}"}
    
    os.makedirs(output_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    page_idx = page_num_1based - 1
    
    if page_idx < 0 or page_idx >= len(doc):
        doc.close()
        return {"error": f"Page out of range"}
    
    page = doc[page_idx]
    page_width = page.rect.width
    page_height = page.rect.height
    
    elements = []
    
    # --- 1. EXTRACT IMAGES ---
    images_info = page.get_image_info(xrefs=True)
    img_counter = 0
    image_map = {}
    crops_dir_name = f"crops-{articleId}" if 'articleId' in locals() else f"crops-{article_id}"
    
    for img in images_info:
        bbox = img['bbox']
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        
        # Skip decorative elements
        if w < 40 or h < 40 or (w / h > 15) or (h / w > 15):
            continue
            
        xref = img['xref']
        if xref == 0: continue
        
        try:
            pix = fitz.Pixmap(doc, xref)
            if pix.n >= 4:
                pix = fitz.Pixmap(fitz.csRGB, pix)
                
            filename = f"page-{page_num_1based}-crop-{img_counter}.png"
            filepath = os.path.join(output_dir, filename)
            pix.save(filepath)
            
            src = f"/uploads/images/{crops_dir_name}/{filename}"
            
            # Record for flow sorting
            y_center = bbox[1] + (h / 2)
            elements.append({
                "y": y_center,
                "type": "image",
                "src": src,
                "caption": "",
                "layout": {
                    "widthRatio": round(w / page_width, 3),
                    "leftRatio": round((bbox[0] + w / 2) / page_width, 3),
                    "topRatio": round(bbox[1] / page_height, 3)
                }
            })
            img_counter += 1
        except Exception:
            continue

    # --- 2. EXTRACT TEXT BLOCKS ---
    text_data = page.get_text("dict")
    blocks = text_data.get("blocks", [])
    
    for b in blocks:
        if b.get("type") != 0: continue # Skip non-text blocks
        
        bbox = b['bbox']
        lines = b.get('lines', [])
        if not lines: continue
        
        # Determine average font size and boldness for this block
        total_chars = 0
        sum_size = 0
        bold_chars = 0
        full_text = []
        
        for line in lines:
            line_text = ""
            for span in line.get('spans', []):
                t = span['text']
                line_text += t
                chars = len(t.strip())
                if chars > 0:
                    total_chars += chars
                    sum_size += span['size'] * chars
                    if is_bold(span['font']):
                        bold_chars += chars
            if line_text.strip():
                full_text.append(line_text.strip())
                
        if total_chars == 0: continue
        
        avg_size = sum_size / total_chars
        is_block_bold = (bold_chars / total_chars) > 0.5
        merged_text = " ".join(full_text).replace("  ", " ")
        
        # Heuristics for formatting
        fmt = "paragraph"
        font_size_token = "base"
        font_weight = "normal"
        text_align = "left"
        
        if is_block_bold:
            font_weight = "bold"
            
        if avg_size > 18:
            fmt = "heading"
            font_size_token = "xxlarge"
            font_weight = "bold"
        elif avg_size > 14:
            fmt = "heading"
            font_size_token = "large"
        
        if page_type == 'poem':
            fmt = "poem"
            merged_text = "\n".join(full_text) # Preserve linebreaks for poems
            
        # Center alignment check (if text is roughly in middle of page horizontally)
        block_w = bbox[2] - bbox[0]
        block_center = bbox[0] + (block_w / 2)
        if abs(block_center - (page_width / 2)) < (page_width * 0.1) and block_w < (page_width * 0.8):
            text_align = "center"
            
        y_center = bbox[1] + ((bbox[3] - bbox[1]) / 2)
        
        elements.append({
            "y": y_center,
            "type": "text",
            "format": fmt,
            "content": merged_text,
            "design": {
                "textAlign": text_align,
                "fontSize": font_size_token,
                "fontWeight": font_weight
            }
        })

    # --- 3. SORT AND FINALIZE LAYOUT ---
    # Sort elements vertically (top to bottom)
    elements.sort(key=lambda e: e['y'])
    
    # Remove 'y' coordinate before returning
    for e in elements:
        del e['y']

    doc.close()
    
    return {
        "contentType": "poetry" if page_type == "poem" else "article",
        "confidence": 1.0,
        "blocks": elements
    }

if __name__ == "__main__":
    if len(sys.argv) < 6:
        print(json.dumps({"error": "Usage: extractLayout.py <pdf_path> <page_num> <output_dir> <article_id> <page_type>"}))
        sys.exit(1)
    
    pdf_path = sys.argv[1]
    page_num = int(sys.argv[2])
    output_dir = sys.argv[3]
    article_id = sys.argv[4]
    page_type = sys.argv[5]
    
    result = extract_layout(pdf_path, page_num, output_dir, article_id, page_type)
    print(json.dumps(result))
