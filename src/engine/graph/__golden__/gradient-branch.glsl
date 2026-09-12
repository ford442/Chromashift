
    if (u_layerIndex == 0) {
      if (lum > 229.0) result = vec4(bandGradient(lum, 229.0, 255.0, 45.0, 60.0, 0.3, 0.80, 1.0), 1.0);
      else if (lum > 209.0) result = vec4(bandGradient(lum, 209.0, 229.0, 10.0, 40.0, 1.0, 0.50, 0.65), 1.0);
      else if (lum > 190.0) result = vec4(bandGradient(lum, 190.0, 209.0, 0.0, 10.0, 1.0, 0.40, 0.55), 1.0);
    } else if (u_layerIndex == 1) {
      if (lum > 177.0 && lum <= 190.0) result = vec4(bandGradient(lum, 177.0, 190.0, 255.0, 290.0, 1.0, 0.40, 0.55), 1.0);
      else if (lum > 158.0 && lum <= 177.0) result = vec4(bandGradient(lum, 158.0, 177.0, 220.0, 255.0, 1.0, 0.38, 0.50), 1.0);
    } else {
      if (lum > 145.0 && lum <= 158.0) result = vec4(bandGradient(lum, 145.0, 158.0, 90.0, 130.0, 1.0, 0.38, 0.50), 1.0);
      else if (lum > 125.0 && lum <= 145.0) result = vec4(bandGradient(lum, 125.0, 145.0, 50.0, 90.0, 1.0, 0.40, 0.52), 1.0);
    }
